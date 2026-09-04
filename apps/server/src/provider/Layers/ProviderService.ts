/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  EventId,
  MessageId,
  ModelSelection,
  NonNegativeInt,
  ProviderCompactSessionInput,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderRespondToUserInputInput,
  RuntimeRequestId,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  ProviderUploadFeedbackInput,
  ThreadId,
  TurnId,
  type ProviderInstanceId,
  type ProviderDriverKind,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { expandAssistantCitationsForProvider } from "@t3tools/shared/assistantCitations";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  increment,
  providerMetricAttributes,
  providerRuntimeEventsTotal,
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  providerTurnMetricAttributes,
  withMetrics,
} from "../../observability/Metrics.ts";
import {
  type ProviderAdapterError,
  ProviderAdapterRequestError,
  ProviderSessionNotFoundError,
  ProviderValidationError,
} from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderService from "../Services/ProviderService.ts";
import * as ProviderSessionDirectory from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "./ProviderEventLoggers.ts";
import * as AnalyticsService from "../../telemetry/AnalyticsService.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import {
  readPersistedProviderActiveTurnId,
  readPersistedProviderCwd,
  readPersistedProviderModelSelection,
} from "../ProviderRestartRecovery.ts";
import {
  readRuntimePayload,
  SERVER_UPDATE_CONTINUATION_KEY,
} from "../providerSessionContinuation.ts";
import * as ServerSettings from "../../serverSettings.ts";

interface PendingCompaction {
  readonly completion: Deferred.Deferred<string>;
  readonly native: boolean;
  readonly providerInstanceId: ProviderInstanceId;
  readonly requestId: MessageId | undefined;
  readonly earlyEvents: ProviderRuntimeEvent[];
  compactedEventObserved: boolean;
  expectedTurnId: TurnId | undefined;
}

/**
 * Hook for tests that want to override the canonical event logger pulled
 * from `ProviderEventLoggers`. Production wiring leaves this undefined and
 * reads the logger off the tag.
 */
export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogger?: EventNdjsonLogger;
  /**
   * Wait this long after cooperative `interruptTurn` on in-flight sessions
   * before hard `adapter.stopAll()`. Gives providers time to cancel tools /
   * flush before process teardown. Default `30 seconds` — well under ops'
   * ~150s main-pid SIGTERM reap window (interrupt grace + stopAll grace must
   * fit inside that).
   */
  readonly shutdownInterruptGracePeriod?: Duration.Input;
  /**
   * Maximum time the server gives all provider adapters, collectively, to
   * stop during process shutdown (after the interrupt grace). Default `1 minute`.
   */
  readonly shutdownGracePeriod?: Duration.Input;
  /**
   * Overrides MCP credential issuance. The real issuer reads a module-global
   * registry that only a running MCP server installs, which makes the
   * agent-browser-access gate unobservable from a unit test; this seam lets a
   * test see whether a credential was requested at all.
   */
  readonly issueMcpCredential?: typeof McpSessionRegistry.issueActiveMcpCredential;
  /** Same seam as `issueMcpCredential`, for observing the deny path's revoke. */
  readonly revokeMcpCredential?: typeof McpSessionRegistry.revokeActiveMcpThread;
}

type ProviderServiceMethod<Name extends keyof ProviderService.ProviderService["Service"]> =
  ProviderService.ProviderService["Service"][Name];

const ProviderRollbackConversationInput = Schema.Struct({
  threadId: ThreadId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) => {
  const decodeProviderRequestInput = Schema.decodeUnknownEffect(input.schema);
  return decodeProviderRequestInput(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );
};

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(
  session: ProviderSession,
  extra?: {
    readonly modelSelection?: unknown;
    readonly interactionMode?: unknown;
    readonly lastRuntimeEvent?: string;
    readonly lastRuntimeEventAt?: string;
  },
): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
    ...(extra?.modelSelection !== undefined ? { modelSelection: extra.modelSelection } : {}),
    ...(extra?.interactionMode !== undefined ? { interactionMode: extra.interactionMode } : {}),
    ...(extra?.lastRuntimeEvent !== undefined ? { lastRuntimeEvent: extra.lastRuntimeEvent } : {}),
    ...(extra?.lastRuntimeEventAt !== undefined
      ? { lastRuntimeEventAt: extra.lastRuntimeEventAt }
      : {}),
  };
}

function normalizeProviderCwd(cwd: string): string {
  const trimmed = cwd.trim();
  return trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, "") : trimmed;
}

function providerCwdMatches(actual: string | undefined, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  return actual !== undefined && normalizeProviderCwd(actual) === normalizeProviderCwd(expected);
}
const dieOnMissingBindingInstanceId = (
  operation: string,
  payload: {
    readonly providerInstanceId?: ProviderInstanceId | undefined;
    readonly provider?: ProviderDriverKind | undefined;
  },
): ProviderInstanceId => {
  if (payload.providerInstanceId !== undefined) {
    return payload.providerInstanceId;
  }
  throw new Error(
    payload.provider
      ? `${operation}: provider instance id is required for provider '${payload.provider}'.`
      : `${operation}: provider instance id is required.`,
  );
};

const correlateRuntimeEventWithInstance = (
  source: {
    readonly instanceId: ProviderInstanceId;
    readonly provider: ProviderDriverKind;
  },
  event: ProviderRuntimeEvent,
): ProviderRuntimeEvent => {
  if (event.provider !== source.provider) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' is backed by driver '${source.provider}' but emitted driver '${event.provider}'.`,
    );
  }
  if (event.providerInstanceId !== undefined && event.providerInstanceId !== source.instanceId) {
    throw new Error(
      `ProviderService.streamEvents: provider instance '${source.instanceId}' emitted event for instance '${event.providerInstanceId}'.`,
    );
  }
  return { ...event, providerInstanceId: source.instanceId };
};

const makeProviderService = Effect.fn("makeProviderService")(function* (
  options?: ProviderServiceLiveOptions,
) {
  const analytics = yield* Effect.service(AnalyticsService.AnalyticsService);
  const serverConfig = yield* ServerConfig.ServerConfig;
  const eventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
  // Options-provided logger wins (test overrides); otherwise we take whatever
  // the `ProviderEventLoggers` tag exposes — `undefined` means "no canonical
  // log writer is attached", which downstream code already handles as a
  // no-op.
  const canonicalEventLogger = options?.canonicalEventLogger ?? eventLoggers.canonical;

  const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const issueMcpCredential =
    options?.issueMcpCredential ?? McpSessionRegistry.issueActiveMcpCredential;
  const revokeMcpCredential =
    options?.revokeMcpCredential ?? McpSessionRegistry.revokeActiveMcpThread;
  const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const pendingCompactions = new Map<ThreadId, PendingCompaction>();
  const timedOutNativeCompactions = new Set<ThreadId>();
  const settleCompaction = (threadId: ThreadId, pending: PendingCompaction, terminal: string) =>
    Effect.gen(function* () {
      if (pendingCompactions.get(threadId) !== pending) return false;
      pendingCompactions.delete(threadId);
      yield* Deferred.succeed(pending.completion, terminal);
      return true;
    });
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  /**
   * Attach the `t3-code` MCP server to the session that is about to start.
   *
   * This is the only place a credential is minted, so withholding one here is
   * what disables agent browser access everywhere: every adapter already
   * treats a missing session as "no MCP server", and the `/mcp` endpoint
   * accepts nothing but tokens issued from this path.
   */
  /**
   * Deny on an unreadable settings file rather than letting the read failure
   * escape: adding `ServerSettingsError` to `ProviderServiceError` would widen
   * a union every caller handles, for a branch that only decides whether one
   * optional toolset is attached. Denying is the safe direction — an explicit
   * "off" silently becoming "on" would violate the user's stated choice,
   * whereas the reverse costs an agent one toolset and is visible immediately.
   */
  const agentBrowserAccessEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.enableAgentBrowserAccess),
    Effect.catch((cause) =>
      Effect.logWarning(
        "Could not read server settings; withholding agent browser access for this session.",
        { cause },
      ).pipe(Effect.as(false)),
    ),
  );

  const prepareMcpSession = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      if (!(yield* agentBrowserAccessEnabled)) {
        // Revoke as well as clear. Every other prepare path reaches
        // `issueActiveMcpCredential`, which revokes the thread first, so
        // skipping it here would leave a previously issued bearer token valid
        // against `/mcp` for the rest of its liveness window — and later turns
        // would keep refreshing it. A session restart (runtime mode, cwd,
        // model) re-prepares without stopping, so it relies on this.
        yield* revokeMcpCredential(threadId);
        yield* Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId));
        return undefined;
      }
      const credential = yield* issueMcpCredential({ threadId, providerInstanceId });
      if (credential) {
        yield* Effect.sync(() => McpProviderSession.setMcpProviderSession(credential.config));
      }
      return credential;
    });
  const clearMcpSession = (threadId: ThreadId) =>
    McpSessionRegistry.revokeActiveMcpThread(threadId).pipe(
      Effect.tap(() => Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
    );

  const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
    Effect.succeed(event).pipe(
      Effect.tap((canonicalEvent) =>
        canonicalEventLogger
          ? canonicalEventLogger.write(canonicalEvent, canonicalEvent.threadId)
          : Effect.void,
      ),
      Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
      Effect.asVoid,
    );

  const persistRuntimeEventState = Effect.fn("persistRuntimeEventState")(function* (
    event: ProviderRuntimeEvent,
  ) {
    const binding = Option.getOrUndefined(yield* directory.getBinding(event.threadId));
    if (!binding || event.providerInstanceId === undefined) return;
    if (binding.providerInstanceId !== event.providerInstanceId) {
      yield* Effect.logWarning("provider runtime event ignored for stale persisted instance", {
        threadId: event.threadId,
        eventType: event.type,
        eventProviderInstanceId: event.providerInstanceId,
        bindingProviderInstanceId: binding.providerInstanceId,
      });
      return;
    }

    const persistedActiveTurnId = readPersistedProviderActiveTurnId(binding.runtimePayload);
    const lifecycle = (() => {
      switch (event.type) {
        case "turn.started":
          return event.turnId === undefined
            ? { status: "running" as const }
            : { status: "running" as const, activeTurnId: event.turnId };
        case "turn.completed":
        case "turn.aborted":
          if (
            persistedActiveTurnId !== undefined &&
            (event.turnId === undefined || event.turnId !== persistedActiveTurnId)
          ) {
            return undefined;
          }
          return { status: "running" as const, activeTurnId: null };
        case "session.exited":
          return { status: "stopped" as const, activeTurnId: null };
        case "session.state.changed":
          switch (event.payload.state) {
            case "starting":
              return { status: "starting" as const };
            case "error":
              return { status: "error" as const, activeTurnId: null };
            case "stopped":
              return { status: "stopped" as const, activeTurnId: null };
            case "ready":
            case "waiting":
              return { status: "running" as const, activeTurnId: null };
            case "running":
              return { status: "running" as const };
          }
        default:
          return undefined;
      }
    })();
    if (lifecycle === undefined) return;

    yield* directory.upsert({
      threadId: event.threadId,
      provider: binding.provider,
      providerInstanceId: event.providerInstanceId,
      ...(binding.runtimeMode !== undefined ? { runtimeMode: binding.runtimeMode } : {}),
      status: lifecycle.status,
      runtimePayload: {
        ...(lifecycle.activeTurnId !== undefined ? { activeTurnId: lifecycle.activeTurnId } : {}),
        lastRuntimeEvent: event.type,
        lastRuntimeEventAt: event.createdAt,
      },
    });
  });
  const isCompactedEvent = (
    event: ProviderRuntimeEvent,
  ): event is Extract<ProviderRuntimeEvent, { readonly type: "thread.state.changed" }> =>
    event.type === "thread.state.changed" && event.payload.state === "compacted";
  const withCompactionRequestId = (
    event: ProviderRuntimeEvent,
    pending: PendingCompaction,
  ): ProviderRuntimeEvent =>
    pending.requestId === undefined
      ? event
      : {
          ...event,
          requestId: RuntimeRequestId.make(String(pending.requestId)),
        };
  const compactionTerminal = (event: ProviderRuntimeEvent): string | null =>
    event.type === "turn.completed"
      ? event.payload.state
      : event.type === "runtime.error" || event.type === "turn.aborted"
        ? event.type
        : null;
  const processFallbackCompactionEvent = (
    pending: PendingCompaction,
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (pendingCompactions.get(event.threadId) !== pending) {
        yield* publishRuntimeEvent(event);
        return;
      }
      const matchesTurn = event.turnId !== undefined && event.turnId === pending.expectedTurnId;
      if (matchesTurn && isCompactedEvent(event)) {
        pending.compactedEventObserved = true;
        yield* publishRuntimeEvent(withCompactionRequestId(event, pending));
        return;
      }
      yield* publishRuntimeEvent(event);
      const terminal = compactionTerminal(event);
      if (!matchesTurn || terminal === null) return;
      const settled = yield* settleCompaction(event.threadId, pending, terminal);
      if (!settled || terminal !== "completed" || pending.compactedEventObserved) return;
      const compactedEvent = {
        ...event,
        eventId: EventId.make(`${event.eventId}:context-compaction`),
        type: "thread.state.changed",
        payload: {
          state: "compacted",
          detail: { source: "provider-native-command" },
        },
        ...(pending.requestId !== undefined
          ? { requestId: RuntimeRequestId.make(String(pending.requestId)) }
          : {}),
      } satisfies ProviderRuntimeEvent;
      yield* increment(providerRuntimeEventsTotal, {
        provider: compactedEvent.provider,
        eventType: compactedEvent.type,
      });
      yield* publishRuntimeEvent(compactedEvent);
    });

  const requireBindingInstanceId = (
    operation: string,
    payload: {
      readonly providerInstanceId?: ProviderInstanceId | undefined;
      readonly provider?: ProviderDriverKind | undefined;
    },
  ): Effect.Effect<ProviderInstanceId, ProviderValidationError> =>
    payload.providerInstanceId !== undefined
      ? Effect.succeed(payload.providerInstanceId)
      : Effect.fail(
          toValidationError(
            operation,
            payload.provider
              ? `Provider instance id is required for provider '${payload.provider}'.`
              : "Provider instance id is required.",
          ),
        );

  const upsertSessionBinding = (
    session: ProviderSession,
    threadId: ThreadId,
    extra?: {
      readonly modelSelection?: unknown;
      readonly interactionMode?: unknown;
      readonly lastRuntimeEvent?: string;
      readonly lastRuntimeEventAt?: string;
    },
  ) =>
    Effect.gen(function* () {
      const providerInstanceId = yield* requireBindingInstanceId(
        "ProviderService.upsertSessionBinding",
        session,
      );
      yield* directory.upsert({
        threadId,
        provider: session.provider,
        providerInstanceId,
        runtimeMode: session.runtimeMode,
        status: toRuntimeStatus(session),
        ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
        runtimePayload: toRuntimePayloadFromSession(session, extra),
      });
    });

  const processRuntimeEvent = (
    source: {
      readonly instanceId: ProviderInstanceId;
      readonly provider: ProviderDriverKind;
    },
    event: ProviderRuntimeEvent,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const canonicalEvent = yield* Effect.sync(() =>
        correlateRuntimeEventWithInstance(source, event),
      );
      yield* increment(providerRuntimeEventsTotal, {
        provider: canonicalEvent.provider,
        eventType: canonicalEvent.type,
      });
      yield* persistRuntimeEventState(canonicalEvent).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist provider runtime lifecycle event", {
            threadId: canonicalEvent.threadId,
            eventType: canonicalEvent.type,
            cause,
          }),
        ),
      );
      if (
        isCompactedEvent(canonicalEvent) &&
        timedOutNativeCompactions.delete(canonicalEvent.threadId)
      ) {
        yield* publishRuntimeEvent(canonicalEvent);
        return;
      }
      const pendingCompaction = pendingCompactions.get(canonicalEvent.threadId);
      if (!pendingCompaction) {
        yield* publishRuntimeEvent(canonicalEvent);
        return;
      }
      if (pendingCompaction.providerInstanceId !== source.instanceId) {
        yield* publishRuntimeEvent(canonicalEvent);
        return;
      }
      if (pendingCompaction.native) {
        const compacted = isCompactedEvent(canonicalEvent);
        const terminal = compacted ? "completed" : compactionTerminal(canonicalEvent);
        yield* publishRuntimeEvent(
          compacted ? withCompactionRequestId(canonicalEvent, pendingCompaction) : canonicalEvent,
        );
        if (terminal !== null)
          yield* settleCompaction(canonicalEvent.threadId, pendingCompaction, terminal);
        return;
      }
      if (
        pendingCompaction.expectedTurnId === undefined &&
        canonicalEvent.turnId !== undefined &&
        (isCompactedEvent(canonicalEvent) || compactionTerminal(canonicalEvent) !== null)
      ) {
        pendingCompaction.earlyEvents.push(canonicalEvent);
        return;
      }
      yield* processFallbackCompactionEvent(pendingCompaction, canonicalEvent);
    });

  // `subscribedAdapters` is our source-of-truth for "which instance adapters
  // are currently wired into the runtime event bus". It both tracks the set
  // of live subscriptions (so `reconcileInstanceSubscriptions` can diff and
  // fork only the *new* or *rebuilt* ones) and serves as the dynamic adapter
  // list consumed by `stopStaleSessionsForThread`, `listSessions`, and
  // `runStopAll` — replacing the pre-Slice-D startup snapshot so hot-added
  // instances become visible to those call sites as soon as settings edits
  // land.
  const subscribedAdapters = yield* Ref.make(
    new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>(),
  );

  const getAdapterEntries = Ref.get(subscribedAdapters).pipe(
    Effect.map((map) => Array.from(map.entries())),
  );

  // Rebuild the map of id → adapter from the registry and fork a new event
  // subscription for every instance that is either brand new or whose adapter
  // identity changed (indicating the underlying `ProviderInstance` was torn
  // down and rebuilt by `ProviderInstanceRegistry.reconcile`). Orphaned
  // fibers for removed/replaced instances exit on their own because their
  // adapter's `streamEvents` source terminates when the old scope closes.
  const reconcileInstanceSubscriptions = Effect.gen(function* () {
    const previous = yield* Ref.get(subscribedAdapters);
    const currentIds = yield* registry.listInstances();
    const next = new Map<ProviderInstanceId, ProviderAdapterShape<ProviderAdapterError>>();
    for (const id of currentIds) {
      const adapterOption = yield* registry
        .getByInstance(id)
        .pipe(Effect.tapError(Effect.logWarning), Effect.option);
      if (Option.isNone(adapterOption)) continue;
      const adapter = adapterOption.value;
      next.set(id, adapter);
      if (previous.get(id) !== adapter) {
        yield* Stream.runForEach(adapter.streamEvents, (event) =>
          processRuntimeEvent(
            {
              instanceId: id,
              provider: adapter.provider,
            },
            event,
          ),
        ).pipe(Effect.forkScoped);
      }
    }
    yield* Ref.set(subscribedAdapters, next);
  });

  const instanceChanges = yield* registry.subscribeChanges;
  yield* reconcileInstanceSubscriptions;
  yield* Stream.runForEach(
    Stream.fromSubscription(instanceChanges),
    () => reconcileInstanceSubscriptions,
  ).pipe(Effect.forkScoped);

  const recoverSessionForThread = Effect.fn("recoverSessionForThread")(function* (input: {
    readonly binding: ProviderSessionDirectory.ProviderRuntimeBinding;
    readonly operation: string;
  }) {
    const bindingInstanceId = yield* requireBindingInstanceId(input.operation, input.binding);
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "recover-session",
      "provider.kind": input.binding.provider,
      "provider.instance_id": bindingInstanceId,
      "provider.thread_id": input.binding.threadId,
    });
    return yield* Effect.gen(function* () {
      const adapter = yield* registry.getByInstance(bindingInstanceId);
      const hasResumeCursor =
        input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
      const hasActiveSession = yield* adapter.hasSession(input.binding.threadId);
      if (hasActiveSession) {
        const activeSessions = yield* adapter.listSessions();
        const existing = activeSessions.find(
          (session) => session.threadId === input.binding.threadId,
        );
        if (existing) {
          const persistedCwd = readPersistedProviderCwd(input.binding.runtimePayload);
          if (!providerCwdMatches(existing.cwd, persistedCwd)) {
            return yield* toValidationError(
              input.operation,
              [
                `Active provider session for thread '${input.binding.threadId}' is in '${existing.cwd ?? "unknown"}' but persisted cwd is '${persistedCwd ?? "unknown"}'.`,
                "Refusing to recover a provider session for the wrong workspace.",
              ].join(" "),
            );
          }
          yield* upsertSessionBinding(
            { ...existing, providerInstanceId: bindingInstanceId },
            input.binding.threadId,
          );
          yield* analytics.record("provider.session.recovered", {
            provider: existing.provider,
            strategy: "adopt-existing",
            hasResumeCursor: existing.resumeCursor !== undefined,
          });
          return { adapter, session: existing } as const;
        }
      }

      if (!hasResumeCursor) {
        return yield* toValidationError(
          input.operation,
          `Cannot recover thread '${input.binding.threadId}' because no provider resume state is persisted.`,
        );
      }

      const persistedCwd = readPersistedProviderCwd(input.binding.runtimePayload);
      const persistedModelSelection = readPersistedProviderModelSelection(
        input.binding.runtimePayload,
      );

      yield* prepareMcpSession(input.binding.threadId, bindingInstanceId);
      const resumed = yield* adapter
        .startSession({
          threadId: input.binding.threadId,
          provider: input.binding.provider,
          providerInstanceId: bindingInstanceId,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(persistedModelSelection ? { modelSelection: persistedModelSelection } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
          runtimeMode: input.binding.runtimeMode ?? "full-access",
        })
        .pipe(Effect.onError(() => clearMcpSession(input.binding.threadId)));
      if (resumed.provider !== adapter.provider) {
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          `Adapter/provider mismatch while recovering thread '${input.binding.threadId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
        );
      }
      if (!providerCwdMatches(resumed.cwd, persistedCwd)) {
        yield* adapter.stopSession(resumed.threadId).pipe(Effect.ignore);
        yield* clearMcpSession(input.binding.threadId);
        return yield* toValidationError(
          input.operation,
          [
            `Recovered provider session for thread '${input.binding.threadId}' is in '${resumed.cwd ?? "unknown"}' but persisted cwd is '${persistedCwd ?? "unknown"}'.`,
            "Refusing to recover a provider session for the wrong workspace.",
          ].join(" "),
        );
      }

      yield* upsertSessionBinding(
        { ...resumed, providerInstanceId: bindingInstanceId },
        input.binding.threadId,
      );
      yield* analytics.record("provider.session.recovered", {
        provider: resumed.provider,
        strategy: "resume-thread",
        hasResumeCursor: resumed.resumeCursor !== undefined,
      });
      return { adapter, session: resumed } as const;
    }).pipe(
      withMetrics({
        counter: providerSessionsTotal,
        attributes: providerMetricAttributes(input.binding.provider, {
          operation: "recover",
        }),
      }),
    );
  });

  const resolveRoutableSession = Effect.fn("resolveRoutableSession")(function* (input: {
    readonly threadId: ThreadId;
    readonly operation: string;
    readonly allowRecovery: boolean;
  }) {
    const bindingOption = yield* directory.getBinding(input.threadId);
    const binding = Option.getOrUndefined(bindingOption);
    if (!binding) {
      return yield* toValidationError(
        input.operation,
        `Cannot route thread '${input.threadId}' because no persisted provider binding exists.`,
      );
    }
    const instanceId = yield* requireBindingInstanceId(input.operation, binding);
    const adapter = yield* registry.getByInstance(instanceId);

    const hasRequestedSession = yield* adapter.hasSession(input.threadId);
    if (hasRequestedSession) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: true,
      } as const;
    }

    if (!input.allowRecovery) {
      return {
        adapter,
        instanceId,
        threadId: input.threadId,
        runtimeMode: binding.runtimeMode,
        isActive: false,
      } as const;
    }

    const recovered = yield* recoverSessionForThread({
      binding,
      operation: input.operation,
    });
    return {
      adapter: recovered.adapter,
      instanceId,
      threadId: input.threadId,
      runtimeMode: recovered.session.runtimeMode,
      isActive: true,
    } as const;
  });

  const stopStaleSessionsForThread = Effect.fn("stopStaleSessionsForThread")(function* (input: {
    readonly threadId: ThreadId;
    readonly currentInstanceId: ProviderInstanceId;
  }) {
    const currentAdapters = yield* getAdapterEntries;
    yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        instanceId === input.currentInstanceId
          ? Effect.void
          : Effect.gen(function* () {
              const hasSession = yield* adapter.hasSession(input.threadId);
              if (!hasSession) {
                return;
              }

              yield* adapter.stopSession(input.threadId).pipe(
                Effect.tap(() =>
                  analytics.record("provider.session.stopped", {
                    provider: adapter.provider,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("provider.session.stop-stale-failed", {
                    threadId: input.threadId,
                    provider: adapter.provider,
                    cause,
                  }),
                ),
              );
            }),
      { discard: true },
    );
  });

  const startSession: ProviderServiceMethod<"startSession"> = Effect.fn("startSession")(
    function* (threadId, rawInput) {
      const parsed = yield* decodeInputOrValidationError({
        operation: "ProviderService.startSession",
        schema: ProviderSessionStartInput,
        payload: rawInput,
      });

      const resolvedInstanceId = yield* requireBindingInstanceId(
        "ProviderService.startSession",
        parsed,
      );
      let metricProvider = parsed.provider ?? String(resolvedInstanceId);
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "start-session",
        "provider.instance_id": resolvedInstanceId,
        "provider.thread_id": threadId,
        "provider.runtime_mode": parsed.runtimeMode,
      });
      return yield* Effect.gen(function* () {
        const instanceInfo = yield* registry.getInstanceInfo(resolvedInstanceId);
        const resolvedProvider = instanceInfo.driverKind;
        metricProvider = resolvedProvider;
        if (parsed.provider !== undefined && parsed.provider !== resolvedProvider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' belongs to driver '${resolvedProvider}', not '${parsed.provider}'.`,
          );
        }
        const input = {
          ...parsed,
          threadId,
          provider: resolvedProvider,
        };
        if (!instanceInfo.enabled) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Provider instance '${resolvedInstanceId}' is disabled in T3 Code settings.`,
          );
        }
        const persistedBinding = Option.getOrUndefined(yield* directory.getBinding(threadId));
        if (
          persistedBinding?.provider === resolvedProvider &&
          persistedBinding.providerInstanceId !== resolvedInstanceId &&
          (input.resumeCursor != null || persistedBinding.resumeCursor != null)
        ) {
          const previousInstanceId = yield* requireBindingInstanceId(
            "ProviderService.startSession",
            persistedBinding,
          );
          const previousInfo = yield* registry.getInstanceInfo(previousInstanceId);
          if (
            previousInfo.continuationIdentity.continuationKey !==
            instanceInfo.continuationIdentity.continuationKey
          ) {
            return yield* toValidationError(
              "ProviderService.startSession",
              `Thread '${threadId}' cannot switch from instance '${previousInstanceId}' to '${resolvedInstanceId}' because their provider resume state is incompatible.`,
            );
          }
        }
        const effectiveResumeCursor =
          input.resumeCursor ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? persistedBinding.resumeCursor
            : undefined);
        const effectiveCwd =
          input.cwd ??
          (persistedBinding?.providerInstanceId === resolvedInstanceId
            ? readPersistedProviderCwd(persistedBinding.runtimePayload)
            : undefined);
        yield* Effect.annotateCurrentSpan({
          "provider.kind": resolvedProvider,
          "provider.resume_cursor.source":
            input.resumeCursor !== undefined
              ? "request"
              : effectiveResumeCursor !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.resume_cursor.present": effectiveResumeCursor !== undefined,
          "provider.cwd.source":
            input.cwd !== undefined
              ? "request"
              : effectiveCwd !== undefined &&
                  persistedBinding?.providerInstanceId === resolvedInstanceId
                ? "persisted"
                : "none",
          "provider.cwd.effective": effectiveCwd ?? "",
        });
        const adapter = yield* registry.getByInstance(resolvedInstanceId);
        yield* prepareMcpSession(threadId, resolvedInstanceId);
        const session = yield* adapter
          .startSession({
            ...input,
            providerInstanceId: resolvedInstanceId,
            ...(effectiveCwd !== undefined ? { cwd: effectiveCwd } : {}),
            ...(effectiveResumeCursor !== undefined ? { resumeCursor: effectiveResumeCursor } : {}),
          })
          .pipe(Effect.onError(() => clearMcpSession(threadId)));

        if (session.provider !== adapter.provider) {
          yield* clearMcpSession(threadId);
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }
        if (!providerCwdMatches(session.cwd, effectiveCwd)) {
          yield* adapter.stopSession(session.threadId).pipe(Effect.ignore);
          yield* clearMcpSession(threadId);
          return yield* toValidationError(
            "ProviderService.startSession",
            [
              `Provider '${adapter.provider}' started in '${session.cwd ?? "unknown"}' but T3 requested '${effectiveCwd}'.`,
              "Refusing to persist a provider session for the wrong workspace.",
            ].join(" "),
          );
        }
        const sessionWithInstance = {
          ...session,
          providerInstanceId: resolvedInstanceId,
        };

        yield* stopStaleSessionsForThread({
          threadId,
          currentInstanceId: resolvedInstanceId,
        });
        yield* upsertSessionBinding(sessionWithInstance, threadId, {
          modelSelection: input.modelSelection,
        });
        yield* analytics.record("provider.session.started", {
          provider: sessionWithInstance.provider,
          runtimeMode: input.runtimeMode,
          hasResumeCursor: sessionWithInstance.resumeCursor !== undefined,
          hasCwd: typeof effectiveCwd === "string" && effectiveCwd.trim().length > 0,
          hasModel:
            typeof input.modelSelection?.model === "string" &&
            input.modelSelection.model.trim().length > 0,
        });
        timedOutNativeCompactions.delete(threadId);

        // Changing runtime mode restarts the session, so the transition is only
        // observable here, by diffing against the mode the previous session for
        // this thread was bound to. Recording it separately is what makes the
        // "started supervised, switched to full access" funnel answerable.
        const previousRuntimeMode = persistedBinding?.runtimeMode;
        if (previousRuntimeMode !== undefined && previousRuntimeMode !== input.runtimeMode) {
          yield* analytics.record("provider.runtime_mode.changed", {
            provider: sessionWithInstance.provider,
            from: previousRuntimeMode,
            to: input.runtimeMode,
          });
        }

        return sessionWithInstance;
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          attributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "start",
            }),
        }),
      );
    },
  );

  const sendTurn: ProviderServiceMethod<"sendTurn"> = Effect.fn("sendTurn")(function* (rawInput) {
    const parsed = yield* decodeInputOrValidationError({
      operation: "ProviderService.sendTurn",
      schema: ProviderSendTurnInput,
      payload: rawInput,
    });

    const attachments = parsed.attachments ?? [];
    if (!parsed.input && attachments.length === 0 && parsed.continuation !== true) {
      return yield* toValidationError(
        "ProviderService.sendTurn",
        "Either input text or at least one attachment is required",
      );
    }

    const inputTextWithCitations =
      parsed.input === undefined ? undefined : expandAssistantCitationsForProvider(parsed.input);
    if (inputTextWithCitations !== parsed.input) {
      yield* decodeInputOrValidationError({
        operation: "ProviderService.sendTurn",
        schema: ProviderSendTurnInput.fields.input,
        payload: inputTextWithCitations,
      });
    }

    // Every attachment gets an on-disk path in the prompt so the model's tools
    // can dereference the actual file. All attachments then go to the adapter,
    // and each adapter decides what its provider ingests natively: OpenCode
    // sends generic files as file parts, the others send images only and rely
    // on the path line for everything else. Unresolvable ids are skipped here
    // and surface as adapter errors when the file is read.
    const attachmentPathLines = attachments.flatMap((attachment) => {
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: serverConfig.attachmentsDir,
        attachment,
      });
      return attachmentPath === null
        ? []
        : [`[Attached ${attachment.type} "${attachment.name}" is saved at: ${attachmentPath}]`];
    });
    const inputTextWithAttachmentPaths =
      attachmentPathLines.length === 0
        ? inputTextWithCitations
        : [inputTextWithCitations, attachmentPathLines.join("\n")]
            .filter((part): part is string => typeof part === "string" && part.length > 0)
            .join("\n\n");

    const input = {
      ...parsed,
      ...(inputTextWithAttachmentPaths !== undefined
        ? { input: inputTextWithAttachmentPaths }
        : {}),
    };
    yield* Effect.annotateCurrentSpan({
      "provider.operation": "send-turn",
      "provider.thread_id": input.threadId,
      "provider.interaction_mode": input.interactionMode,
      "provider.attachment_count": attachments.length,
    });
    let metricProvider = "unknown";
    let metricModel = input.modelSelection?.model;
    return yield* Effect.gen(function* () {
      let routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.sendTurn",
        allowRecovery: false,
      });
      if (
        input.continuation === true &&
        !input.input &&
        attachments.length === 0 &&
        routed.adapter.capabilities.promptlessTurnContinuation !== true
      ) {
        return yield* toValidationError(
          "ProviderService.sendTurn",
          `Provider '${routed.adapter.provider}' requires an explicit continuation prompt`,
        );
      }
      if (!routed.isActive) {
        routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
        });
      }
      metricProvider = routed.adapter.provider;
      metricModel = input.modelSelection?.model;
      yield* Effect.annotateCurrentSpan({
        "provider.kind": routed.adapter.provider,
        ...(input.modelSelection?.model ? { "provider.model": input.modelSelection.model } : {}),
      });
      // A turn is the clearest sign a session is still alive. The MCP
      // credential is minted once at session start and cannot be rotated into
      // an already-spawned agent process, so we keep the existing token valid
      // rather than issuing a new one: sessions that go a long time between
      // browser tool calls used to lose the toolkit outright.
      yield* McpSessionRegistry.touchActiveMcpThread(input.threadId);
      const turn = yield* routed.adapter.sendTurn(input);
      const turnStartedAt = yield* nowIso;
      yield* directory.upsert({
        threadId: input.threadId,
        provider: routed.adapter.provider,
        providerInstanceId: routed.instanceId,
        status: "running",
        ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
        runtimePayload: {
          ...(input.modelSelection !== undefined ? { modelSelection: input.modelSelection } : {}),
          ...(input.interactionMode !== undefined
            ? { interactionMode: input.interactionMode }
            : {}),
          activeTurnId: turn.turnId,
          lastRuntimeEvent: "provider.sendTurn",
          lastRuntimeEventAt: turnStartedAt,
        },
      });
      yield* analytics.record("provider.turn.sent", {
        provider: routed.adapter.provider,
        model: input.modelSelection?.model,
        interactionMode: input.interactionMode,
        // Session-start events alone skew runtime mode toward users who toggle
        // often, since every toggle restarts the session. Recording it per turn
        // gives a usage-weighted view and lets it cross with interactionMode.
        runtimeMode: routed.runtimeMode,
        attachmentCount: attachments.length,
        hasInput: typeof input.input === "string" && input.input.trim().length > 0,
      });
      return turn;
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        timer: providerTurnDuration,
        attributes: () =>
          providerTurnMetricAttributes({
            provider: metricProvider,
            model: metricModel,
            extra: {
              operation: "send",
            },
          }),
      }),
    );
  });

  const compactThread: ProviderServiceMethod<"compactThread"> = Effect.fn("compactThread")(
    function* (threadId, modelSelection, requestId) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.compactThread",
        allowRecovery: true,
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "compact-thread",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": threadId,
      });
      yield* McpSessionRegistry.touchActiveMcpThread(threadId);
      const nativeCompaction = routed.adapter.compactThread;
      const completion = yield* Deferred.make<string>();
      const pending: PendingCompaction = {
        completion,
        native: nativeCompaction !== undefined,
        providerInstanceId: routed.instanceId,
        requestId,
        earlyEvents: [],
        compactedEventObserved: false,
        expectedTurnId: undefined,
      };
      if (nativeCompaction !== undefined && timedOutNativeCompactions.has(threadId)) {
        return yield* new ProviderAdapterRequestError({
          provider: routed.adapter.provider,
          method: "thread/compact",
          detail:
            "The previous context compaction may still be running. Restart the provider session before retrying.",
        });
      }
      const claimed = yield* Effect.sync(() => {
        if (pendingCompactions.has(threadId)) return false;
        pendingCompactions.set(threadId, pending);
        return true;
      });
      if (!claimed) {
        return yield* new ProviderAdapterRequestError({
          provider: routed.adapter.provider,
          method: "thread/compact",
          detail: "Context compaction is already in progress.",
        });
      }
      const clearPending = Effect.sync(() => {
        if (pendingCompactions.get(threadId) === pending) {
          pendingCompactions.delete(threadId);
        }
      });
      const nativeCompletionTimeout =
        routed.adapter.provider === "codex" || routed.adapter.provider === "opencode"
          ? "10 minutes"
          : "30 seconds";
      const awaitNativeCompaction = (start: Effect.Effect<void, ProviderAdapterError>) =>
        start.pipe(
          Effect.andThen(Deferred.await(completion)),
          Effect.timeout(nativeCompletionTimeout),
          Effect.catchTag("TimeoutError", (cause) =>
            Effect.sync(() => {
              timedOutNativeCompactions.add(threadId);
            }).pipe(
              Effect.andThen(
                Effect.fail(
                  new ProviderAdapterRequestError({
                    provider: routed.adapter.provider,
                    method: "thread/compact",
                    detail: `Provider did not report completed context compaction within ${nativeCompletionTimeout}.`,
                    cause,
                  }),
                ),
              ),
            ),
          ),
        );
      const awaitFallbackCompaction = Deferred.await(completion).pipe(
        Effect.timeout("10 minutes"),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterRequestError({
              provider: routed.adapter.provider,
              method: "turn/start",
              detail: "Provider did not finish context compaction within 10 minutes.",
              cause,
            }),
        ),
      );
      const terminal = yield* (
        nativeCompaction
          ? awaitNativeCompaction(nativeCompaction(routed.threadId, modelSelection))
          : Effect.gen(function* () {
              const turn = yield* sendTurn({
                threadId,
                input: routed.adapter.provider === "cursor" ? "/compress" : "/compact",
                ...(modelSelection !== undefined ? { modelSelection } : {}),
              }).pipe(
                Effect.onError(() =>
                  Effect.forEach(pending.earlyEvents.splice(0), publishRuntimeEvent, {
                    discard: true,
                  }),
                ),
              );
              pending.expectedTurnId = turn.turnId;
              const earlyEvents = pending.earlyEvents.splice(0);
              for (const earlyEvent of earlyEvents) {
                yield* processFallbackCompactionEvent(pending, earlyEvent);
              }
              return yield* awaitFallbackCompaction;
            })
      ).pipe(Effect.ensuring(clearPending));
      if (terminal !== "completed") {
        return yield* new ProviderAdapterRequestError({
          provider: routed.adapter.provider,
          method: nativeCompaction ? "thread/compact" : "turn/start",
          detail: `Context compaction ended with ${terminal}.`,
        });
      }
      yield* analytics.record("provider.thread.compacted", {
        provider: routed.adapter.provider,
      });
    },
  );

  const interruptTurn: ProviderServiceMethod<"interruptTurn"> = Effect.fn("interruptTurn")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.interruptTurn",
        schema: ProviderInterruptTurnInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.interruptTurn",
          // Interrupt must never resurrect an old persisted session merely to
          // cancel it. The orchestration reactor authoritatively clears the
          // projected running state even when no live adapter session exists.
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "interrupt-turn",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.turn_id": input.turnId,
        });
        if (routed.isActive) {
          yield* routed.adapter.interruptTurn(routed.threadId, input.turnId);
        }
        yield* analytics.record("provider.turn.interrupted", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "interrupt",
            }),
        }),
      );
    },
  );

  const compactSession: ProviderServiceMethod<"compactSession"> = Effect.fn("compactSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.compactSession",
        schema: ProviderCompactSessionInput,
        payload: rawInput,
      });
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.compactSession",
        allowRecovery: true,
      });
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "compact-session",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      if (routed.adapter.compactSession === undefined) {
        return yield* new ProviderValidationError({
          operation: "ProviderService.compactSession",
          issue: `Provider ${routed.adapter.provider} does not support manual context compact.`,
        });
      }
      if (!routed.isActive) {
        return yield* new ProviderSessionNotFoundError({
          threadId: input.threadId,
        });
      }
      yield* routed.adapter.compactSession(routed.threadId);
    },
  );

  const respondToRequest: ProviderServiceMethod<"respondToRequest"> = Effect.fn("respondToRequest")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.respondToRequest",
        schema: ProviderRespondToRequestInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "respond-to-request",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
          "provider.request_id": input.requestId,
        });
        yield* routed.adapter.respondToRequest(routed.threadId, input.requestId, input.decision);
        yield* analytics.record("provider.request.responded", {
          provider: routed.adapter.provider,
          decision: input.decision,
        });
      }).pipe(
        withMetrics({
          counter: providerTurnsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "approval-response",
            }),
        }),
      );
    },
  );

  const respondToUserInput: ProviderServiceMethod<"respondToUserInput"> = Effect.fn(
    "respondToUserInput",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.respondToUserInput",
      schema: ProviderRespondToUserInputInput,
      payload: rawInput,
    });
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.respondToUserInput",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "respond-to-user-input",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.request_id": input.requestId,
      });
      yield* routed.adapter.respondToUserInput(routed.threadId, input.requestId, input.answers);
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "user-input-response",
          }),
      }),
    );
  });

  const stopSession: ProviderServiceMethod<"stopSession"> = Effect.fn("stopSession")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.stopSession",
        schema: ProviderStopSessionInput,
        payload: rawInput,
      });
      let metricProvider = "unknown";
      return yield* Effect.gen(function* () {
        const routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        metricProvider = routed.adapter.provider;
        yield* Effect.annotateCurrentSpan({
          "provider.operation": "stop-session",
          "provider.kind": routed.adapter.provider,
          "provider.thread_id": input.threadId,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.threadId);
        }
        const pendingCompaction = pendingCompactions.get(input.threadId);
        if (pendingCompaction !== undefined) {
          yield* settleCompaction(input.threadId, pendingCompaction, "turn.aborted");
        }
        timedOutNativeCompactions.delete(input.threadId);
        yield* clearMcpSession(input.threadId);
        yield* directory.upsert({
          threadId: input.threadId,
          provider: routed.adapter.provider,
          providerInstanceId: routed.instanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
          },
        });
        yield* analytics.record("provider.session.stopped", {
          provider: routed.adapter.provider,
        });
      }).pipe(
        withMetrics({
          counter: providerSessionsTotal,
          outcomeAttributes: () =>
            providerMetricAttributes(metricProvider, {
              operation: "stop",
            }),
        }),
      );
    },
  );

  const listSessions: ProviderServiceMethod<"listSessions"> = Effect.fn("listSessions")(
    function* () {
      const currentAdapters = yield* getAdapterEntries;
      const sessionsByProvider = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
        adapter.listSessions().pipe(
          Effect.map((sessions) =>
            sessions.map((session) => ({
              ...session,
              providerInstanceId: instanceId,
            })),
          ),
        ),
      );
      const activeSessions = sessionsByProvider.flatMap((sessions) => sessions);
      // Only live adapter sessions appear in this response. Resolving every
      // historical binding here makes each call scale with the full thread
      // history instead of the active session set.
      const persistedBindings = yield* Effect.forEach(
        [...new Set(activeSessions.map((session) => session.threadId))],
        (threadId) =>
          directory
            .getBinding(threadId)
            .pipe(
              Effect.orElseSucceed(() =>
                Option.none<ProviderSessionDirectory.ProviderRuntimeBinding>(),
              ),
            ),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.orElseSucceed(
          () => [] as Array<Option.Option<ProviderSessionDirectory.ProviderRuntimeBinding>>,
        ),
      );
      const bindingsByThreadId = new Map<
        ThreadId,
        ProviderSessionDirectory.ProviderRuntimeBinding
      >();
      for (const bindingOption of persistedBindings) {
        const binding = Option.getOrUndefined(bindingOption);
        if (binding) {
          bindingsByThreadId.set(binding.threadId, binding);
        }
      }

      const sessions: ProviderSession[] = [];
      for (const session of activeSessions) {
        const binding = bindingsByThreadId.get(session.threadId);
        if (!binding) {
          sessions.push(session);
          continue;
        }

        const overrides: {
          resumeCursor?: ProviderSession["resumeCursor"];
          runtimeMode?: ProviderSession["runtimeMode"];
          providerInstanceId?: ProviderSession["providerInstanceId"];
        } = {};
        overrides.providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.listSessions",
          binding,
        );
        if (binding.provider !== session.provider) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider '${session.provider}' but persisted binding names provider '${binding.provider}'.`,
            ),
          );
        }
        if (overrides.providerInstanceId !== session.providerInstanceId) {
          return yield* Effect.die(
            new Error(
              `ProviderService.listSessions: thread '${session.threadId}' is active on provider instance '${session.providerInstanceId}' but persisted binding names '${overrides.providerInstanceId}'.`,
            ),
          );
        }
        if (session.resumeCursor === undefined && binding.resumeCursor !== undefined) {
          overrides.resumeCursor = binding.resumeCursor;
        }
        if (binding.runtimeMode !== undefined) {
          overrides.runtimeMode = binding.runtimeMode;
        }
        sessions.push(Object.assign({}, session, overrides));
      }
      return sessions;
    },
  );

  const getCapabilities: ProviderServiceMethod<"getCapabilities"> = (instanceId) =>
    registry.getByInstance(instanceId).pipe(Effect.map((adapter) => adapter.capabilities));

  const getInstanceInfo: ProviderServiceMethod<"getInstanceInfo"> = (instanceId) =>
    registry.getInstanceInfo(instanceId);

  const assertConversationRollbackSupported: ProviderServiceMethod<"assertConversationRollbackSupported"> =
    Effect.fn("assertConversationRollbackSupported")(function* (threadId) {
      const routed = yield* resolveRoutableSession({
        threadId,
        operation: "ProviderService.assertConversationRollbackSupported",
        allowRecovery: false,
      });
      if (routed.adapter.capabilities.supportsConversationRollback === false) {
        return yield* toValidationError(
          "ProviderService.assertConversationRollbackSupported",
          `Provider '${routed.adapter.provider}' does not support conversation rewind.`,
        );
      }
    });

  const rollbackConversation: ProviderServiceMethod<"rollbackConversation"> = Effect.fn(
    "rollbackConversation",
  )(function* (rawInput) {
    const input = yield* decodeInputOrValidationError({
      operation: "ProviderService.rollbackConversation",
      schema: ProviderRollbackConversationInput,
      payload: rawInput,
    });
    if (input.numTurns === 0) {
      return;
    }
    let metricProvider = "unknown";
    return yield* Effect.gen(function* () {
      yield* assertConversationRollbackSupported(input.threadId);
      const routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.rollbackConversation",
        allowRecovery: true,
      });
      metricProvider = routed.adapter.provider;
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "rollback-conversation",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
        "provider.rollback_turns": input.numTurns,
      });
      yield* routed.adapter.rollbackThread(routed.threadId, input.numTurns);
      yield* analytics.record("provider.conversation.rolled_back", {
        provider: routed.adapter.provider,
        turns: input.numTurns,
      });
    }).pipe(
      withMetrics({
        counter: providerTurnsTotal,
        outcomeAttributes: () =>
          providerMetricAttributes(metricProvider, {
            operation: "rollback",
          }),
      }),
    );
  });

  const uploadFeedback: ProviderServiceMethod<"uploadFeedback"> = Effect.fn("uploadFeedback")(
    function* (rawInput) {
      const input = yield* decodeInputOrValidationError({
        operation: "ProviderService.uploadFeedback",
        schema: ProviderUploadFeedbackInput,
        payload: rawInput,
      });
      let routed = yield* resolveRoutableSession({
        threadId: input.threadId,
        operation: "ProviderService.uploadFeedback",
        allowRecovery: false,
      });
      if (routed.adapter.uploadFeedback === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      if (!routed.isActive) {
        routed = yield* resolveRoutableSession({
          threadId: input.threadId,
          operation: "ProviderService.uploadFeedback",
          allowRecovery: true,
        });
      }
      const uploadFeedback = routed.adapter.uploadFeedback;
      if (uploadFeedback === undefined) {
        return yield* toValidationError(
          "ProviderService.uploadFeedback",
          `Provider '${routed.adapter.provider}' does not support feedback uploads.`,
        );
      }
      yield* Effect.annotateCurrentSpan({
        "provider.operation": "upload-feedback",
        "provider.kind": routed.adapter.provider,
        "provider.thread_id": input.threadId,
      });
      return yield* uploadFeedback(input);
    },
  );

  const runStopAll = Effect.fn("runStopAll")(function* () {
    const threadIds = yield* directory.listThreadIds();
    const currentAdapters = yield* getAdapterEntries;
    const lastRuntimeEventAt = yield* nowIso;

    const activeSessions = yield* Effect.forEach(currentAdapters, ([instanceId, adapter]) =>
      adapter.listSessions().pipe(
        Effect.map((sessions) =>
          sessions.map((session) => ({
            ...session,
            providerInstanceId: instanceId,
          })),
        ),
      ),
    ).pipe(Effect.map((sessionsByAdapter) => sessionsByAdapter.flatMap((sessions) => sessions)));

    // Same payload key as in-app #9167. Startup reconcileProviderSessions
    // continues marked threads after this process is replaced (systemd
    // restart, deploy). Crash/hard-kill never reaches stopAll, so those
    // still settle as interrupted.
    const persistedBindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    const bindingByThreadId = new Map(
      persistedBindings.map((binding) => [binding.threadId, binding] as const),
    );
    const continuationByThreadId = new Map<ThreadId, TurnId>();
    const considerContinuation = (
      threadId: ThreadId,
      turnId: TurnId | null | undefined,
      resumeCursor: unknown,
    ) => {
      if (turnId === null || turnId === undefined) return;
      if (resumeCursor === null || resumeCursor === undefined) return;
      if (continuationByThreadId.has(threadId)) return;
      continuationByThreadId.set(threadId, turnId);
    };

    for (const session of activeSessions) {
      const working = session.status === "connecting" || session.status === "running";
      if (!working) continue;
      const binding = bindingByThreadId.get(session.threadId);
      considerContinuation(
        session.threadId,
        session.activeTurnId ?? readPersistedProviderActiveTurnId(binding?.runtimePayload),
        binding?.resumeCursor ?? session.resumeCursor,
      );
    }
    for (const binding of persistedBindings) {
      if (binding.status !== "starting" && binding.status !== "running") continue;
      considerContinuation(
        binding.threadId,
        readPersistedProviderActiveTurnId(binding.runtimePayload),
        binding.resumeCursor,
      );
    }

    yield* Effect.forEach(
      [...continuationByThreadId.entries()],
      ([threadId, turnId]) =>
        Effect.gen(function* () {
          const binding = bindingByThreadId.get(threadId);
          if (binding === undefined) return;
          yield* directory.upsert({
            ...binding,
            runtimePayload: {
              ...readRuntimePayload(binding.runtimePayload),
              [SERVER_UPDATE_CONTINUATION_KEY]: turnId,
            },
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to mark provider session for restart continuation", {
              threadId,
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      { discard: true },
    );
    if (continuationByThreadId.size > 0) {
      yield* Effect.logInfo("marked provider sessions to continue after graceful restart", {
        continuationCount: continuationByThreadId.size,
      });
    }

    yield* Effect.forEach(activeSessions, (session) =>
      upsertSessionBinding(session, session.threadId, {
        lastRuntimeEvent: "provider.stopAll",
        lastRuntimeEventAt,
      }),
    ).pipe(Effect.asVoid);

    // Cooperative interrupt before hard session teardown so running provider
    // turns receive cancel (tools stop, agents can settle). Sequence under ops
    // SIGTERM reap (~150s): interrupt → interruptGrace (~30s) → stopAll (~60s).
    const workingSessions = activeSessions.filter(
      (session) => session.status === "connecting" || session.status === "running",
    );
    if (workingSessions.length > 0) {
      yield* Effect.logInfo("interrupting in-flight provider turns before stopAll", {
        sessionCount: workingSessions.length,
      });
      yield* Effect.forEach(
        workingSessions,
        (session) =>
          interruptTurn({
            threadId: session.threadId,
            ...(session.activeTurnId !== null && session.activeTurnId !== undefined
              ? { turnId: session.activeTurnId }
              : {}),
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider interrupt during shutdown failed", {
                threadId: session.threadId,
                provider: session.provider,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        { concurrency: "unbounded", discard: true },
      );

      const interruptGrace = options?.shutdownInterruptGracePeriod ?? "30 seconds";
      yield* Effect.logInfo("waiting for cooperative interrupt grace before stopAll", {
        interruptGrace: String(interruptGrace),
        sessionCount: workingSessions.length,
      });
      // Interruptible so a short process timeout can still abort shutdown.
      yield* Effect.sleep(interruptGrace).pipe(Effect.interruptible);
    }

    const stopAllGrace = options?.shutdownGracePeriod ?? "1 minute";
    const adapterStops = yield* Effect.forEach(
      currentAdapters,
      ([instanceId, adapter]) =>
        adapter.stopAll().pipe(
          Effect.exit,
          Effect.map((exit) => ({ instanceId, exit })),
        ),
      { concurrency: "unbounded" },
    ).pipe(
      // Scope finalizers are uninterruptible by default. Restore
      // interruptibility here so the timeout can release a provider whose
      // protocol drain never completes.
      Effect.interruptible,
      Effect.timeoutOption(stopAllGrace),
    );
    if (Option.isNone(adapterStops)) {
      yield* Effect.logWarning("provider shutdown grace period elapsed", {
        timeout: String(stopAllGrace),
        sessionCount: activeSessions.length,
      });
    } else {
      yield* Effect.forEach(
        adapterStops.value,
        ({ instanceId, exit }) =>
          exit._tag === "Failure"
            ? Effect.logWarning("provider adapter failed during shutdown", { instanceId })
            : Effect.void,
        { discard: true },
      );
    }
    yield* McpSessionRegistry.revokeAllActiveMcpCredentials();
    McpProviderSession.clearAllMcpProviderSessions();
    const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(bindings, (binding) =>
      Effect.gen(function* () {
        const providerInstanceId = dieOnMissingBindingInstanceId(
          "ProviderService.stopAll",
          binding,
        );
        return yield* directory.upsert({
          threadId: binding.threadId,
          provider: binding.provider,
          providerInstanceId,
          status: "stopped",
          runtimePayload: {
            activeTurnId: null,
            lastRuntimeEvent: "provider.stopAll",
            lastRuntimeEventAt: yield* nowIso,
          },
        });
      }),
    ).pipe(Effect.asVoid);
    yield* analytics.record("provider.sessions.stopped_all", {
      sessionCount: threadIds.length,
    });
    yield* analytics.flush;
  });

  yield* Effect.addFinalizer(() =>
    runStopAll().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to stop provider service", {
          errorTag: causeErrorTag(cause),
        }),
      ),
    ),
  );

  return {
    startSession,
    sendTurn,
    compactThread,
    interruptTurn,
    compactSession,
    respondToRequest,
    respondToUserInput,
    stopSession,
    listSessions,
    getCapabilities,
    getInstanceInfo,
    assertConversationRollbackSupported,
    rollbackConversation,
    uploadFeedback,
    // Each access creates a fresh PubSub subscription so that multiple
    // consumers (ProviderRuntimeIngestion, CheckpointReactor, etc.) each
    // independently receive all runtime events.
    get streamEvents(): ProviderServiceMethod<"streamEvents"> {
      return Stream.fromPubSub(runtimeEventPubSub);
    },
  } satisfies ProviderService.ProviderService["Service"];
});

export const ProviderServiceLive = Layer.effect(
  ProviderService.ProviderService,
  makeProviderService(),
);

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService.ProviderService, makeProviderService(options));
}
