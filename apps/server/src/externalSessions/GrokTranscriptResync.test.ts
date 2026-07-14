// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { OrphanSessionRecovery } from "../orchestration/Services/OrphanSessionRecovery.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionRuntimeRepository } from "../persistence/ProviderSessionRuntime.ts";
import { ProjectionThreadMessageRepository } from "../persistence/Services/ProjectionThreadMessages.ts";
import { GrokTranscriptResync, make } from "./GrokTranscriptResync.ts";

const THREAD_ID = ThreadId.make("thread-1");

const update = (sessionUpdate: string, text: string, timestamp: number) =>
  JSON.stringify({
    timestamp,
    method: "session/update",
    params: { sessionId: "s1", update: { sessionUpdate, content: { type: "text", text } } },
  });

/**
 * A grok session log holding one exchange the thread has not seen. Written where
 * the service looks for it (~/.grok/sessions/<url-encoded-cwd>/<sessionId>), under
 * a cwd key no real session can use. Returns the root to remove afterwards.
 */
function writeUpdatesLog(sessionId: string, cwd: string): string {
  const root = NodePath.join(NodeOS.homedir(), ".grok", "sessions", encodeURIComponent(cwd));
  const dir = NodePath.join(root, sessionId);
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, "updates.jsonl");
  NodeFS.writeFileSync(
    file,
    [
      update("user_message_chunk", "first question", 1700000000),
      update("agent_message_chunk", "ANCHOR answer", 1700000001),
      update("user_message_chunk", "only in grok", 1700000002),
      update("agent_message_chunk", "grok answer only in grok", 1700000003),
    ].join("\n"),
  );
  return root;
}

const existingRows = [
  {
    messageId: "m1",
    threadId: THREAD_ID,
    turnId: null,
    role: "user" as const,
    text: "first question",
    isStreaming: false,
    createdAt: "2026-07-13T21:00:00.000Z",
    updatedAt: "2026-07-13T21:00:00.000Z",
  },
  {
    messageId: "m2",
    threadId: THREAD_ID,
    turnId: null,
    role: "assistant" as const,
    text: "ANCHOR answer",
    createdAt: "2026-07-13T21:00:01.000Z",
    isStreaming: false,
    updatedAt: "2026-07-13T21:00:01.000Z",
  },
];

const testLayer = (input: {
  readonly status: string;
  readonly providerName: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly dispatched: Array<OrchestrationCommand>;
  /** Orchestration session status (defaults to ready — idle between turns). */
  readonly sessionStatus?: "ready" | "running" | "stopped" | "interrupted";
  readonly activeTurnId?: string | null;
  /** Live ACP process present (only blocks resync when also mid-turn). */
  readonly hasLiveProcess?: boolean;
  /** When true, settleIfOrphan claims a zombie mid-turn. */
  readonly treatRunningAsOrphan?: boolean;
}) => {
  return Layer.effect(GrokTranscriptResync, make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderSessionRuntimeRepository)({
          getByThreadId: () =>
            Effect.succeed(
              Option.some({
                threadId: THREAD_ID,
                providerName: input.providerName,
                providerInstanceId: null,
                adapterKey: "grok",
                runtimeMode: "full-access" as const,
                status: input.status as never,
                lastSeenAt: "2026-07-14T00:00:00.000Z",
                resumeCursor: { sessionId: input.sessionId },
                runtimePayload: { cwd: input.cwd },
              }),
            ),
        }),
        Layer.mock(ProjectionThreadMessageRepository)({
          listByThreadId: () => Effect.succeed(existingRows as never),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getCommandReadModel: () => Effect.die("unused"),
          getSnapshot: () => Effect.die("unused"),
          getShellSnapshot: () => Effect.die("unused"),
          getArchivedShellSnapshot: () => Effect.die("unused"),
          getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
          getProjectShellById: () => Effect.die("unused"),
          getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
          getThreadCheckpointContext: () => Effect.die("unused"),
          getFullThreadDiffContext: () => Effect.die("unused"),
          getThreadShellById: () =>
            Effect.succeed(
              Option.some({
                id: THREAD_ID,
                projectId: "project-1" as never,
                title: "t",
                session: {
                  threadId: THREAD_ID,
                  status: input.sessionStatus ?? "ready",
                  providerName: "grok",
                  runtimeMode: "full-access" as const,
                  activeTurnId: (input.activeTurnId ?? null) as never,
                  lastError: null,
                  updatedAt: "2026-07-14T00:00:00.000Z",
                },
              } as never),
            ),
          getThreadDetailById: () => Effect.die("unused"),
          getThreadDetailSnapshot: () => Effect.die("unused"),
        }),
        Layer.mock(OrchestrationEngineService)({
          readEvents: () => Stream.empty,
          streamDomainEvents: Stream.empty,
          dispatch: (command) =>
            Effect.sync(() => {
              input.dispatched.push(command);
              return { sequence: 1 };
            }),
        }),
        Layer.mock(OrphanSessionRecovery)({
          hasLiveProcess: () => Effect.succeed(input.hasLiveProcess ?? false),
          settleThread: () => Effect.void,
          settleIfOrphan: () => Effect.succeed(input.treatRunningAsOrphan === true),
          settleAllAfterServerRestart: () =>
            Effect.succeed({ settledSessions: 0, settledRuntimes: 0 }),
        }),
      ),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
};

describe("GrokTranscriptResync", () => {
  it.effect("dispatches a resync when grok's log has run ahead of the thread", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const cwd = "/tmp/t3-resync-ahead";
      const dir = writeUpdatesLog("s-ahead", cwd);
      try {
        const resync = yield* GrokTranscriptResync;
        yield* resync.resyncThread(THREAD_ID);
        assert.strictEqual(dispatched.length, 1);
        const command = dispatched[0]!;
        assert.strictEqual(command.type, "thread.messages.resync");
        if (command.type !== "thread.messages.resync") return;
        // Rewinds to the last known-good message rather than replacing the thread.
        assert.strictEqual(command.afterMessageId, "m2");
        assert.deepStrictEqual(
          command.messages.map((m) => m.text),
          ["only in grok", "grok answer only in grok"],
        );
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(
      Effect.provide(
        testLayer({
          status: "stopped",
          providerName: "grok",
          sessionId: "s-ahead",
          cwd: "/tmp/t3-resync-ahead",
          dispatched,
        }),
      ),
    );
  });

  it.effect(
    "gives concurrent identical resyncs the same command id so dedup collapses them",
    () => {
      const dispatched: Array<OrchestrationCommand> = [];
      return Effect.gen(function* () {
        const dir = writeUpdatesLog("s-dedup", "/tmp/t3-resync-dedup");
        try {
          const resync = yield* GrokTranscriptResync;
          // Several clients opening the same thread at once each compute the same
          // plan before any dispatch lands; command-receipt dedup must collapse
          // them, which it can only do if the command id is content-derived.
          yield* resync.resyncThread(THREAD_ID);
          yield* resync.resyncThread(THREAD_ID);
          assert.strictEqual(dispatched.length, 2);
          assert.strictEqual(dispatched[0]!.commandId, dispatched[1]!.commandId);
        } finally {
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }
      }).pipe(
        Effect.provide(
          testLayer({
            status: "stopped",
            providerName: "grok",
            sessionId: "s-dedup",
            cwd: "/tmp/t3-resync-dedup",
            dispatched,
          }),
        ),
      );
    },
  );

  it.effect("does not resync while a live process is mid-turn", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const cwd = "/tmp/t3-resync-running";
      const dir = writeUpdatesLog("s-running", cwd);
      try {
        const resync = yield* GrokTranscriptResync;
        yield* resync.resyncThread(THREAD_ID);
        // The live ACP stream owns a running turn; resyncing would race it.
        assert.deepStrictEqual(dispatched, []);
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(
      Effect.provide(
        testLayer({
          status: "running",
          providerName: "grok",
          sessionId: "s-running",
          cwd: "/tmp/t3-resync-running",
          dispatched,
          sessionStatus: "running",
          activeTurnId: "turn-live",
          hasLiveProcess: true,
        }),
      ),
    );
  });

  it.effect("resyncs when runtime is running but the turn is idle (session ready)", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const cwd = "/tmp/t3-resync-idle-hold";
      const dir = writeUpdatesLog("s-idle-hold", cwd);
      try {
        const resync = yield* GrokTranscriptResync;
        yield* resync.resyncThread(THREAD_ID);
        // Grok keeps the process/runtime "running" between turns; external CLI
        // activity must still be pulled from updates.jsonl on open.
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0]?.type, "thread.messages.resync");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(
      Effect.provide(
        testLayer({
          status: "running",
          providerName: "grok",
          sessionId: "s-idle-hold",
          cwd: "/tmp/t3-resync-idle-hold",
          dispatched,
          sessionStatus: "ready",
          activeTurnId: null,
          hasLiveProcess: true,
        }),
      ),
    );
  });

  it.effect("settles a zombie mid-turn runtime then resyncs from the session log", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const cwd = "/tmp/t3-resync-zombie-running";
      const dir = writeUpdatesLog("s-zombie", cwd);
      try {
        const resync = yield* GrokTranscriptResync;
        yield* resync.resyncThread(THREAD_ID);
        assert.equal(dispatched.length, 1);
        assert.equal(dispatched[0]?.type, "thread.messages.resync");
      } finally {
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }).pipe(
      Effect.provide(
        testLayer({
          status: "running",
          providerName: "grok",
          sessionId: "s-zombie",
          cwd: "/tmp/t3-resync-zombie-running",
          dispatched,
          sessionStatus: "running",
          activeTurnId: "turn-zombie",
          hasLiveProcess: false,
          treatRunningAsOrphan: true,
        }),
      ),
    );
  });

  it.effect("ignores non-grok threads", () => {
    const dispatched: Array<OrchestrationCommand> = [];
    return Effect.gen(function* () {
      const resync = yield* GrokTranscriptResync;
      yield* resync.resyncThread(THREAD_ID);
      assert.deepStrictEqual(dispatched, []);
    }).pipe(
      Effect.provide(
        testLayer({
          status: "stopped",
          providerName: "codex",
          sessionId: "s-codex",
          cwd: "/tmp/t3-resync-codex",
          dispatched,
        }),
      ),
    );
  });

  it.effect("stays silent when the grok log is missing", () =>
    Effect.gen(function* () {
      const resync = yield* GrokTranscriptResync;
      // Opening a thread must not fail just because its provider log is gone.
      yield* resync.resyncThread(THREAD_ID);
    }).pipe(
      Effect.provide(
        testLayer({
          status: "stopped",
          providerName: "grok",
          sessionId: "s-missing",
          cwd: "/tmp/t3-resync-missing",
          dispatched: [],
        }),
      ),
    ),
  );
});
