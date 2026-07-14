import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  type OrchestrationSession,
  type ThreadId,
} from "@t3tools/contracts";
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
      const status = input.status ?? "interrupted";

      // Best-effort: stop any live process and clear the runtime binding.
      yield* providerService
        .stopSession({ threadId: input.threadId })
        .pipe(Effect.catch(() => markRuntimeStopped(input.threadId)));
      // stopSession no-ops when there is no binding/process — still force runtime.
      yield* markRuntimeStopped(input.threadId);

      const shell = yield* projectionSnapshotQuery.getThreadShellById(input.threadId).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );

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
        for (const thread of snapshot.threads) {
          if (!isLiveClaimingSessionStatus(thread.session?.status)) {
            continue;
          }
          yield* settleThread({
            threadId: thread.id,
            reason: "server_restart",
            status: "interrupted",
          });
          threadIds.add(String(thread.id));
          settledSessions += 1;
        }

        let settledRuntimes = 0;
        for (const binding of bindings) {
          if (binding.status !== "running" && binding.status !== "starting") {
            continue;
          }
          if (threadIds.has(String(binding.threadId))) {
            // Already settled with the shell session above.
            settledRuntimes += 1;
            continue;
          }
          // Runtime claims live without a matching shell running session —
          // still clear the binding so resync/reaper do not skip forever.
          yield* settleThread({
            threadId: binding.threadId,
            reason: "server_restart",
            status: "interrupted",
          });
          settledRuntimes += 1;
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
