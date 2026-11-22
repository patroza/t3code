import {
  type AuthSessionId,
  CommandId,
  IDENTITY_WS_METHODS,
  type IdentityClaimInput,
  IdentityError,
  type IdentitySetClientClaimInput,
  type OrchestrationV2Command,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2ThreadLaunchError,
  type OrchestrationV2ThreadLaunchInput,
  type SourceRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as IdentityService from "./IdentityService.ts";
import { planThreadAttributionRepair } from "./repairThreadAttribution.ts";
import { resolveDispatchSource, stampOrchestrationCommandSource } from "./stampSource.ts";

/** RPC aggregate names for `RpcInstrumentation`. */
export const identityRpcAggregates = {
  [IDENTITY_WS_METHODS.identityGetSnapshot]: "identity",
  [IDENTITY_WS_METHODS.identityGetSessionClaim]: "identity",
  [IDENTITY_WS_METHODS.identityClaim]: "identity",
  [IDENTITY_WS_METHODS.identityClearClaim]: "identity",
  [IDENTITY_WS_METHODS.identityListClientClaims]: "identity",
  [IDENTITY_WS_METHODS.identitySetClientClaim]: "identity",
} as const;

const repairRejected = (cause: unknown) =>
  new IdentityError({
    code: "identity_attribution_repair_rejected",
    message: cause instanceof Error ? cause.message : String(cause),
  });

/**
 * Identity for one WebSocket session: the identity.* handlers plus the wrappers that stamp
 * the session's person onto the operate commands it dispatches and the threads it launches.
 */
export const makeIdentityWsSession = Effect.fn("identity.makeWsSession")(function* (
  currentSessionId: AuthSessionId,
) {
  // Hosts without the persisted layer (tests, embedded runtimes) get the env map with memory claims.
  const identity = yield* Effect.serviceOption(IdentityService.IdentityService).pipe(
    Effect.flatMap(Option.match({ onNone: () => IdentityService.make, onSome: Effect.succeed })),
  );
  const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const sessions = yield* SessionStore.SessionStore;
  const orchestrator = yield* Orchestrator.OrchestratorV2;

  const operateIdentity = Effect.fn("identity.operateIdentity")(function* () {
    const clientDeviceType = (yield* sessions
      .listActive()
      .pipe(Effect.orElseSucceed(() => []))).find((entry) => entry.sessionId === currentSessionId)
      ?.client.deviceType;
    const claim = yield* identity.requireOperateClaim(
      currentSessionId,
      clientDeviceType === undefined ? {} : { clientDeviceType },
    );
    return { claim, clientDeviceType, people: yield* identity.listMapPeople() };
  });

  const mcpClientSession = Effect.fn("identity.mcpClientSession")(function* (
    sessionId: AuthSessionId,
  ) {
    const clientSessions = yield* serverAuth
      .listClientSessions(currentSessionId)
      .pipe(Effect.orDie);
    const target = clientSessions.find((session) => session.sessionId === sessionId);
    if (target === undefined || target.subject !== EnvironmentAuth.MCP_CLIENT_SUBJECT) {
      return yield* new IdentityError({
        code: "identity_session_not_assignable",
        message: "Identity can be set on an MCP client session only.",
      });
    }
    return target;
  });

  const readProjection = (threadId: ThreadId) =>
    orchestrator.getThreadProjection(threadId).pipe(Effect.mapError(repairRejected));

  const handlers = {
    [IDENTITY_WS_METHODS.identityGetSnapshot]: () => identity.getSnapshot(),
    [IDENTITY_WS_METHODS.identityGetSessionClaim]: () => identity.getSessionClaim(currentSessionId),
    [IDENTITY_WS_METHODS.identityClaim]: (payload: IdentityClaimInput) =>
      identity.claim(currentSessionId, payload),
    [IDENTITY_WS_METHODS.identityClearClaim]: () => identity.clearClaim(currentSessionId),
    [IDENTITY_WS_METHODS.identityListClientClaims]: Effect.fn("identity.listClientClaims")(
      function* () {
        const clientSessions = yield* serverAuth
          .listClientSessions(currentSessionId)
          .pipe(Effect.orDie);
        const claims = yield* Effect.forEach(
          clientSessions.filter(
            (session) => session.subject === EnvironmentAuth.MCP_CLIENT_SUBJECT,
          ),
          (session) => identity.getSessionClaim(session.sessionId),
          { concurrency: 1 },
        );
        return { claims: claims.flatMap(({ claim }) => (claim === null ? [] : [claim])) };
      },
    ),
    [IDENTITY_WS_METHODS.identitySetClientClaim]: Effect.fn("identity.setClientClaim")(function* (
      payload: IdentitySetClientClaimInput,
    ) {
      yield* mcpClientSession(payload.sessionId);
      if (payload.username === null) {
        yield* identity.clearClaim(payload.sessionId);
        return { claim: null };
      }
      const result = yield* identity.claim(payload.sessionId, {
        username: payload.username,
        method: "settings",
      });
      const threadIds = payload.repairThreadIds ?? [];
      if (threadIds.length === 0) return result;
      const projections = new Map(
        (yield* Effect.forEach(threadIds, readProjection, { concurrency: 1 })).map(
          (projection) => [projection.thread.id, projection] as const,
        ),
      );
      for (const rootId of new Set(
        [...projections.values()].map((projection) => projection.thread.lineage.rootThreadId),
      )) {
        if (!projections.has(rootId)) projections.set(rootId, yield* readProjection(rootId));
      }
      const repairs = yield* Effect.try({
        try: () => planThreadAttributionRepair({ claim: result.claim, projections, threadIds }),
        catch: repairRejected,
      });
      for (const repair of repairs) {
        yield* orchestrator
          .dispatch({
            type: "thread.attribution.repair",
            commandId: CommandId.make(
              `identity-repair:${payload.sessionId}:${result.claim.personId}:${repair.threadId}`,
            ),
            ...repair,
          })
          .pipe(Effect.mapError(repairRejected));
      }
      return result;
    }),
  };

  /** Wraps the dispatch handler: the command it sees carries the server's source, never the client's. */
  const stampDispatch =
    <A, E, R>(dispatch: (command: OrchestrationV2Command) => Effect.Effect<A, E, R>) =>
    (command: OrchestrationV2Command) =>
      operateIdentity().pipe(
        Effect.map((operator) => stampOrchestrationCommandSource({ ...operator, command })),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2DispatchCommandError({
              commandId: command.commandId,
              commandType: command.type,
              message: cause.message,
              detail: cause.message,
            }),
        ),
        Effect.flatMap(dispatch),
      );

  /** Wraps the launch handler: its initial message carries the server-stamped source. */
  const stampLaunch =
    <A, E, R>(
      launch: (
        input: OrchestrationV2ThreadLaunchInput & {
          readonly initialMessage?:
            | (NonNullable<OrchestrationV2ThreadLaunchInput["initialMessage"]> & {
                readonly source?: SourceRef;
              })
            | undefined;
        },
      ) => Effect.Effect<A, E, R>,
    ) =>
    (input: OrchestrationV2ThreadLaunchInput) =>
      operateIdentity().pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2ThreadLaunchError({
              commandId: input.commandId,
              projectId: input.projectId,
              message: cause.message,
              cause,
            }),
        ),
        Effect.flatMap((operator) => {
          const source =
            input.initialMessage === undefined
              ? undefined
              : resolveDispatchSource({ ...operator, hint: input.sourceHint });
          const { sourceHint: _hint, ...rest } = input;
          return launch(
            source === undefined || rest.initialMessage === undefined
              ? rest
              : { ...rest, initialMessage: { ...rest.initialMessage, source } },
          );
        }),
      );

  return { handlers, stampDispatch, stampLaunch };
});
