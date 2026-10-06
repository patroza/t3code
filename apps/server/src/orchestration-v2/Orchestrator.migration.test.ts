import { assert, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ContextHandoffId,
  OrchestrationV2Command,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";

import {
  appendContextHandoffId,
  canReplayCommandReceipt,
  legacyImportAlreadyInNativeThread,
  shouldPrepareLegacyImportHandoff,
} from "./Orchestrator.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      alreadyInNativeThread: true,
    }),
  );
});

it("treats an inlined v1 import as already in that native session", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread:grok");
  const delivered = {
    strategy: "manual_context" as const,
    fromProviderThreadIds: [],
    toProviderThreadId: providerThreadId,
    delivery: {
      nativeThreadId: "native-1",
      status: "inline" as const,
      itemIds: [],
    },
  };
  assert.isTrue(
    legacyImportAlreadyInNativeThread({
      providerThreadId,
      nativeThreadId: "native-1",
      handoffs: [delivered],
    }),
  );
  assert.isFalse(
    legacyImportAlreadyInNativeThread({
      providerThreadId,
      nativeThreadId: "native-1",
      handoffs: [{ ...delivered, delivery: { ...delivered.delivery, status: "pending" } }],
    }),
  );
  assert.isFalse(
    legacyImportAlreadyInNativeThread({
      providerThreadId,
      nativeThreadId: undefined,
      handoffs: [delivered],
    }),
  );
});

it("records a reissued legacy handoff on an existing provider thread", () => {
  const existingHandoffId = ContextHandoffId.make("handoff:legacy-import:existing");
  const retryHandoffId = ContextHandoffId.make("handoff:legacy-import:retry");

  assert.deepEqual(appendContextHandoffId([existingHandoffId], retryHandoffId), [
    existingHandoffId,
    retryHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], existingHandoffId), [
    existingHandoffId,
  ]);
  assert.deepEqual(appendContextHandoffId([existingHandoffId], null), [existingHandoffId]);
});

it("only replays a command receipt for the thread it was recorded against", () => {
  const threadA = ThreadId.make("thread-a");
  const threadB = ThreadId.make("thread-b");

  assert.strictEqual(canReplayCommandReceipt(threadA, threadA), true);
  // A reused command id aimed at another thread must not report the first
  // thread's success as this thread's (v1 #5246).
  assert.strictEqual(canReplayCommandReceipt(threadA, threadB), false);
});

it("links and unlinks a pull request through thread.metadata.update (#8160)", () => {
  // The fold is exercised through the schema: a command carrying the link
  // must round-trip, and one without it must leave the field untouched.
  const decode = Schema.decodeUnknownSync(OrchestrationV2Command);
  const linked = decode({
    type: "thread.metadata.update",
    commandId: "command-link",
    threadId: "thread-1",
    linkedPullRequest: {
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 8160,
      url: "https://github.com/pingdotgg/t3code/pull/8160",
    },
  });
  assert.deepStrictEqual(
    (linked as Extract<typeof linked, { type: "thread.metadata.update" }>).linkedPullRequest,
    {
      projectId: "project-1",
      repository: "pingdotgg/t3code",
      number: 8160,
      url: "https://github.com/pingdotgg/t3code/pull/8160",
    },
  );
  const unlinked = decode({
    type: "thread.metadata.update",
    commandId: "command-unlink",
    threadId: "thread-1",
    linkedPullRequest: null,
  });
  assert.strictEqual(
    (unlinked as Extract<typeof unlinked, { type: "thread.metadata.update" }>).linkedPullRequest,
    null,
  );
});
