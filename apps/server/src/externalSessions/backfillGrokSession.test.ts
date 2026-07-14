// @effect-diagnostics nodeBuiltinImport:off
import { assert, describe, it } from "@effect/vitest";

import {
  planGrokBackfill,
  readGrokDisplayMessages,
  resolveGrokChatHistoryPath,
  type ExistingThreadMessage,
  type GrokDisplayMessage,
} from "./backfillGrokSession.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const SESSION_ID = "session-abc";

// A grok history where T3 already has the anchor assistant + two orphan user
// prompts, but is missing every grok answer and a middle prompt.
// emittedAtMs is intentionally far in the past here: the planner must still keep
// the tail ordered against the thread's existing timestamps.
const grokMessage = (
  role: "user" | "assistant",
  text: string,
  lineIndex: number,
): GrokDisplayMessage => ({ role, text, lineIndex, emittedAtMs: 0 });

const grok: ReadonlyArray<GrokDisplayMessage> = [
  grokMessage("user", "first question", 2),
  grokMessage("assistant", "ANCHOR answer to first", 4),
  grokMessage("user", "how will batches stay uptodate?", 10),
  grokMessage("assistant", "grok answer to batches", 14),
  grokMessage("user", "middle prompt only in grok", 18),
  grokMessage("assistant", "grok answer to middle", 22),
  grokMessage("user", "what model is this?", 30),
  grokMessage("assistant", "grok answer about the model", 34),
];

const existingMessage = (
  messageId: string,
  role: string,
  text: string,
  createdAt: string,
): ExistingThreadMessage => ({
  messageId,
  role,
  text,
  turnId: null,
  attachmentsJson: "[]",
  createdAt,
  updatedAt: createdAt,
});

const existing: ReadonlyArray<ExistingThreadMessage> = [
  existingMessage("m1", "user", "first question", "2026-07-13T21:00:00.000Z"),
  existingMessage("m2", "assistant", "ANCHOR answer to first", "2026-07-13T21:07:33.745Z"),
  existingMessage("m3", "user", "how will batches stay uptodate?", "2026-07-14T04:29:58.885Z"),
  existingMessage("m4", "user", "what model is this?", "2026-07-14T05:20:41.120Z"),
];

describe("planGrokBackfill", () => {
  it("adds only the new messages, skipping ones already in the thread", () => {
    const plan = planGrokBackfill({
      grokMessages: grok,
      existingMessages: existing,
      sessionId: SESSION_ID,
    });
    assert.isUndefined(plan.error);
    assert.strictEqual(plan.anchorLineIndex, 4);
    // Rewind point is the last known-good message, not the whole thread.
    assert.strictEqual(plan.anchorMessageId, "m2");
    // The two orphan prompts already present must be skipped, not duplicated.
    assert.strictEqual(plan.skippedExisting, 2);
    const added = plan.newMessages.map((m) => m.text);
    assert.deepStrictEqual(added, [
      "grok answer to batches",
      "middle prompt only in grok",
      "grok answer to middle",
      "grok answer about the model",
    ]);
  });

  it("builds the full authoritative tail, preserving existing message identity", () => {
    const plan = planGrokBackfill({
      grokMessages: grok,
      existingMessages: existing,
      sessionId: SESSION_ID,
    });
    // The tail is everything after the anchor — existing messages included, in
    // their correct positions — so the projector/client can replace it wholesale.
    assert.deepStrictEqual(
      plan.tail.map((m) => ({ id: m.messageId, isNew: m.isNew })),
      [
        { id: "m3", isNew: false },
        { id: plan.tail[1]!.messageId, isNew: true },
        { id: plan.tail[2]!.messageId, isNew: true },
        { id: plan.tail[3]!.messageId, isNew: true },
        { id: "m4", isNew: false },
        { id: plan.tail[5]!.messageId, isNew: true },
      ],
    );
    // Messages the thread already had keep their original timestamps.
    assert.strictEqual(plan.tail[0]!.createdAt, "2026-07-14T04:29:58.885Z");
    assert.strictEqual(plan.tail[4]!.createdAt, "2026-07-14T05:20:41.120Z");
  });

  it("interleaves synthesized timestamps in chronological order", () => {
    const plan = planGrokBackfill({
      grokMessages: grok,
      existingMessages: existing,
      sessionId: SESSION_ID,
    });
    const byText = new Map(plan.newMessages.map((m) => [m.text, m.createdAt]));
    // Messages between the two orphan prompts land inside the 04:29 -> 05:20 gap.
    assert.isTrue(byText.get("grok answer to batches")! > "2026-07-14T04:29:58.885Z");
    assert.isTrue(byText.get("grok answer to middle")! < "2026-07-14T05:20:41.120Z");
    // The final answer lands strictly after the last orphan prompt.
    assert.isTrue(byText.get("grok answer about the model")! > "2026-07-14T05:20:41.120Z");
    // Timestamps are strictly increasing in emission order.
    const times = plan.newMessages.map((m) => m.createdAt);
    for (let i = 1; i < times.length; i += 1) {
      assert.isTrue(times[i]! > times[i - 1]!);
    }
  });

  it("is idempotent: re-planning after applying adds nothing", () => {
    const plan = planGrokBackfill({
      grokMessages: grok,
      existingMessages: existing,
      sessionId: SESSION_ID,
    });
    // Applying replaces everything after the anchor with the tail.
    const afterApply: ReadonlyArray<ExistingThreadMessage> = [
      existing[0]!,
      existing[1]!,
      ...plan.tail.map((m) => existingMessage(m.messageId, m.role, m.text, m.createdAt)),
    ];
    const second = planGrokBackfill({
      grokMessages: grok,
      existingMessages: afterApply,
      sessionId: SESSION_ID,
    });
    assert.isUndefined(second.error);
    assert.strictEqual(second.newMessages.length, 0);
  });

  it("produces stable message ids across runs", () => {
    const a = planGrokBackfill({
      grokMessages: grok,
      existingMessages: existing,
      sessionId: SESSION_ID,
    });
    const b = planGrokBackfill({
      grokMessages: grok,
      existingMessages: existing,
      sessionId: SESSION_ID,
    });
    assert.deepStrictEqual(
      a.newMessages.map((m) => m.messageId),
      b.newMessages.map((m) => m.messageId),
    );
  });

  it("rebuildAll replaces the whole transcript with no anchor", () => {
    const plan = planGrokBackfill({
      grokMessages: grok,
      existingMessages: existing,
      sessionId: SESSION_ID,
      rebuildAll: true,
    });
    assert.isUndefined(plan.error);
    // No anchor => the client/projector replace everything they hold.
    assert.strictEqual(plan.anchorMessageId, null);
    assert.strictEqual(plan.anchorLineIndex, null);
    // The tail is the full grok transcript, not just what follows an anchor.
    assert.strictEqual(plan.tail.length, grok.length);
    assert.deepStrictEqual(
      plan.tail.map((m) => m.text),
      grok.map((m) => m.text),
    );
  });

  it("rebuildAll still works on a thread with no assistant message to anchor on", () => {
    const plan = planGrokBackfill({
      grokMessages: grok,
      existingMessages: [],
      sessionId: SESSION_ID,
      rebuildAll: true,
    });
    assert.isUndefined(plan.error);
    assert.strictEqual(plan.newMessages.length, grok.length);
  });

  it("refuses to guess when the anchor is missing from grok history", () => {
    const plan = planGrokBackfill({
      grokMessages: grok.filter((m) => m.text !== "ANCHOR answer to first"),
      existingMessages: existing,
      sessionId: SESSION_ID,
    });
    assert.isDefined(plan.error);
    assert.strictEqual(plan.newMessages.length, 0);
  });
});

describe("readGrokDisplayMessages", () => {
  const update = (sessionUpdate: string, text: string | undefined, timestamp: number) => ({
    timestamp,
    method: "session/update",
    params: {
      sessionId: "s1",
      update: {
        sessionUpdate,
        ...(text === undefined ? {} : { content: { type: "text", text } }),
      },
    },
  });

  it("keeps user + assistant message chunks with their emit time, drops everything else", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "grok-backfill-test-"));
    const file = NodePath.join(dir, "updates.jsonl");
    const records = [
      update("user_message_chunk", "real prompt", 1700000000),
      update("agent_thought_chunk", "thinking out loud", 1700000001),
      update("tool_call", undefined, 1700000002),
      update("tool_call_update", undefined, 1700000003),
      update("agent_message_chunk", "the real answer", 1700000004),
      update("hook_execution", undefined, 1700000005),
      update("turn_completed", undefined, 1700000006),
      update("agent_message_chunk", "   ", 1700000007),
    ];
    NodeFS.writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"));
    try {
      const messages = readGrokDisplayMessages(file);
      assert.deepStrictEqual(
        messages.map((m) => ({ role: m.role, text: m.text, emittedAtMs: m.emittedAtMs })),
        [
          { role: "user", text: "real prompt", emittedAtMs: 1700000000000 },
          { role: "assistant", text: "the real answer", emittedAtMs: 1700000004000 },
        ],
      );
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns nothing for a missing update log rather than throwing", () => {
    assert.deepStrictEqual(readGrokDisplayMessages("/definitely/not/here/updates.jsonl"), []);
  });
});

describe("resolveGrokChatHistoryPath", () => {
  it("reads updates.jsonl, not the compactable chat_history.jsonl", () => {
    // chat_history.jsonl is grok's LLM context and gets rewritten by compaction,
    // so it cannot be trusted to still hold the messages T3 missed.
    const path = resolveGrokChatHistoryPath({ cwd: "/w", sessionId: "s1" });
    assert.isTrue(path.endsWith("updates.jsonl"));
    assert.isFalse(path.includes("chat_history"));
  });
});

describe("resolveGrokChatHistoryPath", () => {
  it("url-encodes the cwd like the grok CLI does", () => {
    const path = resolveGrokChatHistoryPath({
      cwd: "/home/p/.t3/worktrees/scanner/scanner-0d571b34",
      sessionId: "019f5cf1",
    });
    assert.isTrue(
      path.endsWith(
        NodePath.join(
          ".grok",
          "sessions",
          "%2Fhome%2Fp%2F.t3%2Fworktrees%2Fscanner%2Fscanner-0d571b34",
          "019f5cf1",
          "updates.jsonl",
        ),
      ),
    );
  });
});
