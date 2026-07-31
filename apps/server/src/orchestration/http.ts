import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  type EnvironmentRequestInvalidReason,
  IdentityError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { projectThreadDetailSnapshot } from "./ActivityPayloadProjection.ts";
import { normalizeDispatchCommand } from "./Normalizer.ts";
import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentInvalidRequest,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { GrokTranscriptResync } from "../externalSessions/GrokTranscriptResync.ts";
import * as IdentityService from "../identity/IdentityService.ts";
import { stampOrchestrationCommandSource } from "../identity/stampSource.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const identityErrorToHttpReason = (error: IdentityError): EnvironmentRequestInvalidReason => {
  switch (error.code) {
    case "identity_claim_required":
    case "identity_claim_missing":
      return "identity_claim_required";
    case "identity_unknown_person":
      return "identity_unknown_person";
    default:
      return "identity_map_invalid";
  }
};

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const grokTranscriptResync = yield* GrokTranscriptResync;
    const identity = yield* IdentityService.IdentityService;
    const sessions = yield* SessionStore.SessionStore;

    return handlers
      .handle(
        "snapshot",
        Effect.fn("environment.orchestration.snapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // The only consumer (the `t3` CLI project resolver) reads just
          // `.projects`, so use the command read model — it returns the same
          // OrchestrationReadModel shape but never materialises the per-thread
          // activity/message/checkpoint tables (490MB+ on a busy DB → heap OOM).
          return yield* projectionSnapshotQuery
            .getCommandReadModel()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "shellSnapshot",
        Effect.fn("environment.orchestration.shellSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* projectionSnapshotQuery
            .getShellSnapshot()
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_snapshot_failed", cause),
              ),
            );
        }),
      )
      .handle(
        "threadSnapshot",
        Effect.fn("environment.orchestration.threadSnapshot")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          // Desktop/web cold-load the snapshot over HTTP before the WS
          // subscribe. Resync here so the gzip HTTP payload already includes
          // any grok-session-log catch-up (and so afterSequence catch-up is not
          // the only path that heals dropped ACP updates).
          yield* grokTranscriptResync.resyncThread(args.params.threadId);
          const snapshot = yield* projectionSnapshotQuery
            .getThreadDetailSnapshot(args.params.threadId)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_thread_snapshot_failed", cause),
              ),
            );
          if (Option.isNone(snapshot)) {
            return yield* failEnvironmentNotFound("thread_not_found");
          }
          return projectThreadDetailSnapshot(snapshot.value);
        }),
      )
      .handle(
        "dispatch",
        Effect.fn("environment.orchestration.dispatch")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const session = yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const clientDeviceType = yield* sessions.listActive().pipe(
            Effect.map(
              (active) =>
                active.find((entry) => entry.sessionId === session.sessionId)?.client.deviceType,
            ),
            Effect.orElseSucceed(() => undefined),
          );
          const operateClaim = yield* identity
            .requireOperateClaim(
              session.sessionId,
              clientDeviceType !== undefined ? { clientDeviceType } : {},
            )
            .pipe(
              Effect.catchTag("IdentityError", (error) =>
                failEnvironmentInvalidRequest(identityErrorToHttpReason(error)),
              ),
            );
          const mapPeople = yield* identity.listMapPeople();
          const normalizedCommand = stampOrchestrationCommandSource({
            command: yield* normalizeDispatchCommand(args.payload).pipe(
              Effect.catch(() => failEnvironmentInvalidRequest("invalid_command")),
            ),
            claim: operateClaim,
            clientDeviceType,
            people: mapPeople,
          });
          return yield* orchestrationEngine
            .dispatch(normalizedCommand)
            .pipe(
              Effect.catch((cause) =>
                failEnvironmentInternal("orchestration_dispatch_failed", cause),
              ),
            );
        }),
      );
  }),
);
