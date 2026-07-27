import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  type OrchestrationSession,
  type ThreadId,
} from "@t3tools/contracts";
import {
  resolveOrphanSettleSessionStatus,
  sessionHadInProgressWork,
} from "@t3tools/shared/sessionWake";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  OrphanSessionRecovery,
  type OrphanSessionRecoveryReason,
  type OrphanSessionRecoveryShape,
} from "../Services/OrphanSessionRecovery.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../../provider/Services/ProviderSessionDirectory.ts";

function isLiveClaimingSessionStatus(
  status: OrchestrationSession["status"] | undefined | null,
): boolean {
  return status === "starting" || status === "running";
}

export function shouldSettleAfterServerRestart(input: {
  readonly claimsLive: boolean;
  readonly hasLiveProcess: boolean;
}): boolean {
  return input.claimsLive && !input.hasLiveProcess;
}

function inProgressWorkFromShell(
  shell:
    | {
        readonly session?: {
          readonly activeTurnId?: string | null;
        } | null;
        readonly latestTurn?: { readonly state?: string | null } | null;
        readonly hasPendingApprovals?: boolean;
        readonly hasPendingUserInput?: boolean;
      }
    | null
    | undefined,
): boolean {
  if (shell === null || shell === undefined) return false;
  return sessionHadInProgressWork({
    activeTurnId: shell.session?.activeTurnId ?? null,
    latestTurnState: shell.latestTurn?.state ?? null,
    hasPendingApprovals: shell.hasPendingApprovals === true,
    hasPendingUserInput: shell.hasPendingUserInput === true,
  });
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const providerService = yield* ProviderService;
  const directory = yield* ProviderSessionDirectory;
  const crypto = yield* Crypto.Crypto;

  const hasLiveProcess: OrphanSessionRecoveryShape["hasLiveProcess"] = (threadId) =>
    providerService.listSessions().pipe(
      Effect.map((sessions) =>
        sessions.some((session) => String(session.threadId) === String(threadId)),
      ),
      Effect.orElseSucceed(() => false),
    );

  const markRuntimeStopped = (threadId: ThreadId) =>
    directory.getBinding(threadId).pipe(
      Effect.flatMap((binding) => {
        if (Option.isNone(binding)) {
          return Effect.void;
        }
        const current = binding.value;
        if (current.status === "stopped") {
          return Effect.void;
        }
        return directory.upsert({
          threadId: current.threadId,
          provider: current.provider,
          ...(current.providerInstanceId !== undefined
            ? { providerInstanceId: current.providerInstanceId }
            : {}),
          ...(current.adapterKey !== undefined ? { adapterKey: current.adapterKey } : {}),
          status: "stopped",
          ...(current.resumeCursor !== undefined ? { resumeCursor: current.resumeCursor } : {}),
          runtimePayload: {
            ...(typeof current.runtimePayload === "object" &&
            current.runtimePayload !== null &&
            !Array.isArray(current.runtimePayload)
              ? (current.runtimePayload as Record<string, unknown>)
              : {}),
            activeTurnId: null,
            lastError: "Recovered orphan provider runtime.",
          },
          ...(current.runtimeMode !== undefined ? { runtimeMode: current.runtimeMode } : {}),
        });
      }),
      Effect.catch(() => Effect.void),
    );

  const settleThread: OrphanSessionRecoveryShape["settleThread"] = (input) =>
    Effect.gen(function* () {
      const now = DateTime.formatIso(yield* DateTime.now);
      // Callers may pass interrupted/stopped; still demote to ready when nothing
      // was actually in progress so zombie "running" sessions do not Wake Required.
      const shellForDecision = yield* projectionSnapshotQuery
        .getThreadShellById(input.threadId)
        .pipe(
          Effect.map(Option.getOrUndefined),
          Effect.orElseSucceed(() => undefined),
        );
      const preferred = input.status ?? "interrupted";
      const hadInProgressWork = inProgressWorkFromShell(shellForDecision);
      const status =
        preferred === "ready"
          ? "ready"
          : resolveOrphanSettleSessionStatus({
              hadInProgressWork,
              preferredWhenInProgress: preferred === "stopped" ? "stopped" : "interrupted",
            });

      // Best-effort: stop any live process and clear the runtime binding.
      yield* providerService
        .stopSession({ threadId: input.threadId })
        .pipe(Effect.catch(() => markRuntimeStopped(input.threadId)));
      // stopSession no-ops when there is no binding/process — still force runtime.
      yield* markRuntimeStopped(input.threadId);

      const shell = shellForDecision;
      const previous = shell?.session ?? null;
      const session: OrchestrationSession = {
        threadId: input.threadId,
        status,
        providerName: previous?.providerName ?? null,
        ...(previous?.providerInstanceId !== undefined
          ? { providerInstanceId: previous.providerInstanceId }
          : {}),
        runtimeMode: previous?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        activeTurnId: null,
        lastError:
          status === "interrupted"
            ? `Recovered orphan session (${input.reason}). Send a follow-up to resume.`
            : status === "ready"
              ? null
              : (previous?.lastError ?? null),
        updatedAt: now,
      };

      const commandId = yield* crypto.randomUUIDv4.pipe(
        Effect.orElseSucceed(() => `orphan-settle-${input.threadId}-${now}`),
      );
      yield* orchestrationEngine
        .dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(commandId),
          threadId: input.threadId,
          session,
          createdAt: now,
        })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("orphan session settle dispatch failed", {
              threadId: input.threadId,
              reason: input.reason,
              cause,
            }),
          ),
        );

      yield* Effect.logWarning("settled orphan provider session", {
        threadId: input.threadId,
        reason: input.reason,
        status,
      });
    });

  const settleIfOrphan: OrphanSessionRecoveryShape["settleIfOrphan"] = (
    threadId,
    reason: OrphanSessionRecoveryReason = "resync_zombie_running",
  ) =>
    Effect.gen(function* () {
      if (yield* hasLiveProcess(threadId)) {
        return false;
      }

      const shell = yield* projectionSnapshotQuery.getThreadShellById(threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      const binding = yield* directory.getBinding(threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );

      const sessionStatus = shell?.session?.status;
      const hasActiveTurn = shell?.session?.activeTurnId != null;
      const runtimeClaimsLive = binding?.status === "running" || binding?.status === "starting";

      if (!isLiveClaimingSessionStatus(sessionStatus) && !hasActiveTurn && !runtimeClaimsLive) {
        return false;
      }

      // settleThread demotes to ready when nothing was in progress.
      yield* settleThread({
        threadId,
        reason,
        status: "interrupted",
      });
      return true;
    });

  const settleAllAfterServerRestart: OrphanSessionRecoveryShape["settleAllAfterServerRestart"] =
    () =>
      Effect.gen(function* () {
        const snapshot = yield* projectionSnapshotQuery
          .getShellSnapshot()
          .pipe(Effect.orElseSucceed(() => ({ threads: [] as const })));
        const bindings = yield* directory.listBindings().pipe(Effect.orElseSucceed(() => []));
        const threadIds = new Set<string>();

        let settledSessions = 0;
        let interruptedSessions = 0;
        for (const thread of snapshot.threads) {
          const claimsLive = isLiveClaimingSessionStatus(thread.session?.status);
          const processIsLive = claimsLive ? yield* hasLiveProcess(thread.id) : false;
          // Provider restart reconciliation runs before this audit and may
          // already have resumed the thread. Never classify that replacement
          // process as an orphan merely because its projected session is live.
          if (
            !shouldSettleAfterServerRestart({
              claimsLive,
              hasLiveProcess: processIsLive,
            })
          ) {
            continue;
          }
          const hadInProgressWork = inProgressWorkFromShell(thread);
          const status = resolveOrphanSettleSessionStatus({ hadInProgressWork });
          yield* settleThread({
            threadId: thread.id,
            reason: "server_restart",
            status,
          });
          threadIds.add(String(thread.id));
          settledSessions += 1;
          if (status === "interrupted") interruptedSessions += 1;
        }

        let settledRuntimes = 0;
        for (const binding of bindings) {
          const claimsLive = binding.status === "running" || binding.status === "starting";
          if (!claimsLive) {
            continue;
          }
          if (threadIds.has(String(binding.threadId))) {
            // Already settled with the shell session above.
            settledRuntimes += 1;
            continue;
          }
          if (
            !shouldSettleAfterServerRestart({
              claimsLive,
              hasLiveProcess: yield* hasLiveProcess(binding.threadId),
            })
          ) {
            continue;
          }
          // Runtime claims live without a matching shell running session —
          // clear the binding. Only Wake Required when shell still shows work.
          const shell = yield* projectionSnapshotQuery.getThreadShellById(binding.threadId).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          );
          const status = resolveOrphanSettleSessionStatus({
            hadInProgressWork: inProgressWorkFromShell(shell),
          });
          yield* settleThread({
            threadId: binding.threadId,
            reason: "server_restart",
            status,
          });
          settledRuntimes += 1;
        }

        if (settledSessions > 0 || settledRuntimes > 0) {
          yield* Effect.logInfo("orphan settle after server restart", {
            settledSessions,
            interruptedSessions,
            readyOnlySessions: Math.max(0, settledSessions - interruptedSessions),
            settledRuntimes,
          });
        }

        return { settledSessions, settledRuntimes };
      });

  return {
    hasLiveProcess,
    settleThread,
    settleIfOrphan,
    settleAllAfterServerRestart,
  } satisfies OrphanSessionRecoveryShape;
});

export const OrphanSessionRecoveryLive = Layer.effect(OrphanSessionRecovery, make);
