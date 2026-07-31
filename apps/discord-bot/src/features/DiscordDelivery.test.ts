import { describe, expect, it } from "vite-plus/test";

import {
  assistantMessagesForDelivery,
  beginDeliveryEpoch,
  decideAssistantDelivery,
  decideHeartbeat,
  deliveryTextFromAssistants,
  excludeFinalizedAssistants,
  initialDeliveryEpochState,
  isGrownFinalizedText,
  shouldRecreateTip,
  type DeliveryEpochState,
} from "./DiscordDelivery.ts";

const msg = (
  id: string,
  role: "user" | "assistant",
  text: string,
  turnId: string | null = null,
) => ({ id, role, text, turnId });

/**
 * Drive idle delivery to finalize.
 * Short status lines use settle grace (stream then finalize); substantial answers
 * finalize on the first idle snapshot (avoids Working.. under full finals).
 */
const settleFinalize = (
  state: DeliveryEpochState,
  input: {
    readonly turnId: string | null;
    readonly assistants: ReadonlyArray<{ readonly id: string; readonly text: string }>;
    readonly messages?: ReadonlyArray<{
      readonly id: string;
      readonly role: string;
      readonly turnId: string | null;
      readonly text: string;
    }>;
  },
) => {
  const first = decideAssistantDelivery({
    state,
    turnId: input.turnId,
    turnInProgress: false,
    assistants: input.assistants,
    ...(input.messages !== undefined ? { messages: input.messages } : {}),
    streaming: false,
    presentationFull: true,
  });
  if (first.intent._tag === "finalize") {
    return first;
  }
  expect(first.intent._tag).toBe("stream");
  expect(first.state.settleReady).toBe(true);
  return decideAssistantDelivery({
    state: first.state,
    turnId: input.turnId,
    turnInProgress: false,
    assistants: input.assistants,
    ...(input.messages !== undefined ? { messages: input.messages } : {}),
    streaming: false,
    presentationFull: true,
  });
};

describe("assistantMessagesForDelivery", () => {
  it("reproduces 2nd-message-after-restart: stale completed latestTurn + new user → empty", () => {
    // Turn 1 completed; user 2 arrives; orchestration still reports latestTurn = turn-1.
    const messages = [
      msg("u1", "user", "verify bot up to date", "t1"),
      msg("a1", "assistant", "Yes — the running bot is up to date.\n\n| Check | Result |", "t1"),
      msg("u2", "user", "perfect. Seems better now", null),
    ];
    const assistants = assistantMessagesForDelivery({
      messages,
      turnId: "t1",
      turnInProgress: false,
      hasLatestTurn: true,
    });
    expect(assistants).toEqual([]);
    expect(deliveryTextFromAssistants(assistants, "answer")).toBe("");
  });

  it("keeps mid-turn pre-steer assistants while the turn is still running", () => {
    const messages = [
      msg("u1", "user", "start", "t1"),
      msg("a-pre", "assistant", "long findings…", "t1"),
      msg("u-steer", "user", "also check X", null),
    ];
    const assistants = assistantMessagesForDelivery({
      messages,
      turnId: "t1",
      turnInProgress: true,
      hasLatestTurn: true,
    });
    expect(assistants.map((a) => a.id)).toEqual(["a-pre"]);
  });

  it("returns empty when turn id advanced but no assistants yet", () => {
    const messages = [
      msg("u1", "user", "first", "t1"),
      msg("a1", "assistant", "first answer", "t1"),
      msg("u2", "user", "second", "t2"),
    ];
    expect(
      assistantMessagesForDelivery({
        messages,
        turnId: "t2",
        turnInProgress: true,
        hasLatestTurn: true,
      }),
    ).toEqual([]);
  });

  it("time-query race: new turnId in progress, new user not in snapshot yet → empty when prior was finalized", () => {
    // Production: startTurn advanced latestTurn before the new user message appeared.
    // afterLastUser would otherwise return a1 (PR #102 body) and re-stream it.
    const messages = [
      msg("u1", "user", "show me what you got", "t1"),
      msg("a1", "assistant", "PR #102 is already merged…", "t1"),
    ];
    expect(
      assistantMessagesForDelivery({
        messages,
        turnId: "t2",
        turnInProgress: true,
        hasLatestTurn: true,
        lastFinalizedAssistantId: "a1",
      }),
    ).toEqual([]);
  });

  it("comment-recover race: new turn in progress, no lastFinalized yet → still empty (no prior final under Working)", () => {
    // Production: bridge recovered after a comment; startTurn opened t2 before durable
    // lastFinalizedAssistantId was available. Falling back to afterLastUser re-streamed
    // the previous final as `_Working.._` + Stop under the full prior answer.
    const messages = [
      msg("u1", "user", "rebase and adversarial PR review", "t1"),
      msg(
        "a1",
        "assistant",
        "PR #1901 is rebased, green locally, and mergeable…\n\n## Done\n1. Rebased…",
        "t1",
      ),
    ];
    expect(
      assistantMessagesForDelivery({
        messages,
        turnId: "t2",
        turnInProgress: true,
        hasLatestTurn: true,
        // Intentionally omit lastFinalizedAssistantId — must not leak a1.
      }),
    ).toEqual([]);
  });

  it("drops multi-bubble prior turn when only the last id was finalized", () => {
    const messages = [
      msg("u1", "user", "first", "t1"),
      msg("a0", "assistant", "findings…", "t1"),
      msg("a1", "assistant", "PR #102 is already merged…", "t1"),
      msg("u2", "user", "what's the time", "t2"),
      msg("a2", "assistant", "08:51 UTC", "t2"),
    ];
    const assistants = assistantMessagesForDelivery({
      messages,
      turnId: "t2",
      turnInProgress: false,
      hasLatestTurn: true,
      lastFinalizedAssistantId: "a1",
    });
    expect(assistants.map((a) => a.id)).toEqual(["a2"]);
    expect(deliveryTextFromAssistants(assistants, "answer")).toBe("08:51 UTC");
  });

  it("stale lastFinalized outside tip does not block newer after-last-user answer (dead Working tip)", () => {
    // Production a3b2b737…: durable lastFinalized pointed at an older bubble that had
    // rolled out of the retained tip. Drop-all on missing cursor zeroed deliveryAssistants
    // so Discord stayed on `_Working.._` after the agent finished ("Yep — here").
    const messages = [
      msg("u1", "user", "yes proceed, use english copy", "t1"),
      msg("a1", "assistant", "Sorry for the lag — finished and pushed. PR #872…", "t1"),
      msg("u2", "user", "u there?", "t2"),
      msg("a2", "assistant", "Yep — here. What do you need?", "t2"),
    ];
    const assistants = assistantMessagesForDelivery({
      messages,
      turnId: "t2",
      turnInProgress: false,
      hasLatestTurn: true,
      lastFinalizedAssistantId: "assistant:ancient-not-in-retained-tip:segment:3",
    });
    expect(assistants.map((a) => a.id)).toEqual(["a2"]);
    expect(deliveryTextFromAssistants(assistants, "answer")).toBe("Yep — here. What do you need?");
  });

  it("stale lastFinalized outside tip still allows in-progress stream of current turn", () => {
    const messages = [
      msg("u1", "user", "implement backoffice.access", "t1"),
      msg("a1", "assistant", "Implementing clean migration logic…", "t1"),
    ];
    const assistants = assistantMessagesForDelivery({
      messages,
      turnId: "t1",
      turnInProgress: true,
      hasLatestTurn: true,
      lastFinalizedAssistantId: "assistant:ancient-not-in-retained-tip:segment:3",
    });
    expect(assistants.map((a) => a.id)).toEqual(["a1"]);
  });
});

describe("excludeFinalizedAssistants", () => {
  it("keeps only assistants after the finalized bubble in message order", () => {
    const messages = [
      msg("u1", "user", "x"),
      msg("a1", "assistant", "old"),
      msg("a2", "assistant", "new"),
    ];
    expect(
      excludeFinalizedAssistants({
        messages,
        assistants: [
          { id: "a1", text: "old" },
          { id: "a2", text: "new" },
        ],
        lastFinalizedAssistantId: "a1",
      }).map((a) => a.id),
    ).toEqual(["a2"]);
  });

  it("keeps retained-window assistants when lastFinalized is outside the window", () => {
    // Missing cursor cannot be ordered vs the tip (stale-behind vs ahead). Dropping the
    // whole tip deadlocked live Discord threads on Working. Keep non-matching ids;
    // reconnect re-seed is owned by DiscordThreadFollower resume-after.
    const messages = [
      msg("u-old", "user", "implement sibling threads"),
      msg("a-old", "assistant", "Done. PR #156 …"),
    ];
    expect(
      excludeFinalizedAssistants({
        messages,
        assistants: [{ id: "a-old", text: "Done. PR #156 …" }],
        lastFinalizedAssistantId: "a-later-not-in-window",
      }).map((a) => a.id),
    ).toEqual(["a-old"]);
  });

  it("still gates exact lastFinalized id when that id is the only candidate", () => {
    // Cursor missing from messages list, but candidate id equals lastFinalized → drop
    // unless text grew (growth reopen is covered elsewhere).
    expect(
      excludeFinalizedAssistants({
        messages: [msg("u1", "user", "x")],
        assistants: [{ id: "a1", text: "already posted" }],
        lastFinalizedAssistantId: "a1",
        lastFinalizedText: "already posted",
      }),
    ).toEqual([]);
  });

  it("keeps same id when text grew past lastFinalizedText", () => {
    expect(
      isGrownFinalizedText("Checking PR and CI status now.", "Checking PR and CI status now."),
    ).toBe(false);
    expect(
      isGrownFinalizedText(
        "Checking PR and CI status now.\n\nDone and waiting on CI with full details about the PR.",
        "Checking PR and CI status now.",
      ),
    ).toBe(true);
  });
});

describe("decideAssistantDelivery epoch FSM", () => {
  it("after finalize, further stream/finalize of the same assistant is noop (no final+Working mess)", () => {
    let state = beginDeliveryEpoch(initialDeliveryEpochState());
    const assistants = [{ id: "a1", text: "Good to hear.\n\nThe main issues…" }];

    const fin = settleFinalize(state, { turnId: "t1", assistants });
    expect(fin.intent._tag).toBe("finalize");
    state = fin.state;
    expect(state.phase).toBe("finalized");

    // Same bubble only — must not reopen Working with the body.
    const lateStream = decideAssistantDelivery({
      state,
      turnId: "t1",
      turnInProgress: true,
      assistants,
      streaming: true,
      presentationFull: true,
    });
    expect(lateStream.intent).toEqual({ _tag: "noop", reason: "epoch-finalized" });

    const lateFinal = decideAssistantDelivery({
      state,
      turnId: "t1",
      turnInProgress: false,
      assistants,
      streaming: false,
      presentationFull: true,
    });
    expect(lateFinal.intent).toEqual({ _tag: "noop", reason: "epoch-finalized" });
  });

  it("settle grace: first idle snapshot streams, second finalizes", () => {
    let state = beginDeliveryEpoch(initialDeliveryEpochState());
    const assistants = [{ id: "a1", text: "Checking PR and CI status now." }];
    const first = decideAssistantDelivery({
      state,
      turnId: "t1",
      turnInProgress: false,
      assistants,
      streaming: false,
      presentationFull: true,
    });
    expect(first.intent._tag).toBe("stream");
    expect(first.state.settleReady).toBe(true);
    expect(first.state.phase).toBe("streaming");

    const second = decideAssistantDelivery({
      state: first.state,
      turnId: "t1",
      turnInProgress: false,
      assistants,
      streaming: false,
      presentationFull: true,
    });
    expect(second.intent._tag).toBe("finalize");
  });

  it("skipSettleGrace finalizes on the first idle snapshot (rehydrate catch-up)", () => {
    // Regression: idle-link rehydrate of a completed turn streamed the full answer as
    // Working.. · N tool calls and waited for a second snapshot that never arrived.
    const state = beginDeliveryEpoch(initialDeliveryEpochState());
    const assistants = [
      {
        id: "a1",
        text: "PR #1971 ready for review\n\nThis PR extracted pure plans…",
      },
    ];
    const decision = decideAssistantDelivery({
      state,
      turnId: "t1",
      turnInProgress: false,
      assistants,
      streaming: false,
      presentationFull: true,
      skipSettleGrace: true,
    });
    expect(decision.intent._tag).toBe("finalize");
    if (decision.intent._tag === "finalize") {
      expect(decision.intent.text).toContain("PR #1971");
    }
    expect(decision.state.phase).toBe("finalized");
  });

  it("substantial settled answers finalize on first idle snapshot (no Working under full final)", () => {
    // Recovery after a comment: previous turn body is huge and settled. Streaming it
    // with Working.. + Stop under the answer is not allowed.
    const state = beginDeliveryEpoch(initialDeliveryEpochState());
    const assistants = [
      {
        id: "a1",
        text: [
          "PR #1901 is rebased, green locally, and mergeable (no conflicts).",
          "",
          "## Done",
          "1. Rebased onto latest origin/main (20 commits).",
          "2. Conflict resolution in e2e specs (PR-side Engagement fixtures).",
          "3. Rebase breakage fixed across PausePicking and API e2e paths.",
          "4. pnpm validate:changed green (1,246 tests).",
          "5. Pushed (45d366a70).",
        ].join("\n"),
      },
    ];
    const decision = decideAssistantDelivery({
      state,
      turnId: "t1",
      turnInProgress: false,
      assistants,
      streaming: false,
      presentationFull: true,
    });
    expect(decision.intent._tag).toBe("finalize");
    if (decision.intent._tag === "finalize") {
      expect(decision.intent.text).toContain("PR #1901");
      expect(decision.intent.text).not.toMatch(/Working/i);
    }
    expect(decision.state.phase).toBe("finalized");
  });

  it("reopens after premature finalize when a later assistant bubble is the real answer", () => {
    // Production: finalized "Checking PR and CI status now." (30 chars), then
    // "Done and waiting on CI…" never posted because epoch-finalized blocked it.
    let state = beginDeliveryEpoch(initialDeliveryEpochState());
    const messages = [
      msg("u1", "user", "where do we stand?", "t1"),
      msg("a1", "assistant", "Checking PR and CI status now.", "t1"),
    ];
    const status = settleFinalize(state, {
      turnId: "t1",
      assistants: [{ id: "a1", text: "Checking PR and CI status now." }],
      messages,
    });
    expect(status.intent._tag).toBe("finalize");
    state = status.state;
    expect(state.lastFinalizedAssistantId).toBe("a1");

    const withAnswer = [
      ...messages,
      msg("a2", "assistant", "Done and waiting on CI.\n\n- Fix shipped in code\n- PR open", "t1"),
    ];
    const reopened = settleFinalize(state, {
      turnId: "t1",
      assistants: [
        { id: "a1", text: "Checking PR and CI status now." },
        {
          id: "a2",
          text: "Done and waiting on CI.\n\n- Fix shipped in code\n- PR open",
        },
      ],
      messages: withAnswer,
    });
    expect(reopened.intent._tag).toBe("finalize");
    if (reopened.intent._tag === "finalize") {
      expect(reopened.intent.assistantId).toBe("a2");
      expect(reopened.intent.text).toContain("Done and waiting on CI");
      expect(reopened.intent.text).not.toContain("Checking PR");
    }
    expect(reopened.state.lastFinalizedAssistantId).toBe("a2");
  });

  it("heartbeat is noop after finalize (prevents Working tip under final post)", () => {
    let state = beginDeliveryEpoch(initialDeliveryEpochState());
    const fin = settleFinalize(state, {
      turnId: "t1",
      assistants: [{ id: "a1", text: "Good to hear." }],
    });
    state = fin.state;

    expect(
      decideHeartbeat({
        state,
        turnInProgress: false,
        hasOpenTip: false,
      }),
    ).toEqual({ _tag: "noop", reason: "heartbeat-inactive-phase" });

    // Even if tip ids were lost and turn still looks running, do not recreate.
    expect(
      shouldRecreateTip({
        state,
        updateFailed: true,
        turnInProgress: true,
      }),
    ).toBe(false);
  });

  it("new epoch after Working ack allows a fresh stream (not prior final text)", () => {
    let state = beginDeliveryEpoch(initialDeliveryEpochState());
    const first = settleFinalize(state, {
      turnId: "t1",
      assistants: [{ id: "a1", text: "Yes — the running bot is up to date." }],
    });
    state = first.state;
    expect(state.lastFinalizedAssistantId).toBe("a1");

    // 2nd user message → new Working ack → new epoch.
    state = beginDeliveryEpoch(state, { turnId: "t2" });
    expect(state.phase).toBe("awaiting");
    expect(state.streamText).toBe("");
    expect(state.epoch).toBe(2);

    // Stale snapshot still showing a1 while awaiting t2 (hold Working, never re-post).
    const hold = decideAssistantDelivery({
      state,
      turnId: "t1", // stale
      turnInProgress: false,
      assistants: [{ id: "a1", text: "Yes — the running bot is up to date." }],
      streaming: false,
      presentationFull: true,
    });
    expect(hold.intent._tag).toBe("hold");
    expect(hold.intent).toMatchObject({ reason: "assistant-already-finalized" });

    // Real new-turn content.
    const stream = decideAssistantDelivery({
      state,
      turnId: "t2",
      turnInProgress: true,
      assistants: [{ id: "a2", text: "Glad it is better." }],
      streaming: true,
      presentationFull: true,
    });
    expect(stream.intent._tag).toBe("stream");
    if (stream.intent._tag === "stream") {
      expect(stream.intent.text).toBe("Glad it is better.");
      expect(stream.intent.assistantId).toBe("a2");
    }
  });

  it("time-query race: turnInProgress must not re-stream already-finalized prior answer", () => {
    // Logs 2026-07-21: hold → stream a1 (PR#102) while turnInProgress for new turn →
    // finalize PR#102; real time answer never posted (epoch already finalized).
    let state = beginDeliveryEpoch(initialDeliveryEpochState());
    const prior = settleFinalize(state, {
      turnId: "t1",
      assistants: [{ id: "a1", text: "PR #102 is already merged…" }],
    });
    state = beginDeliveryEpoch(prior.state, { turnId: "t2" });

    const messages = [
      msg("u1", "user", "show me what you got", "t1"),
      msg("a1", "assistant", "PR #102 is already merged…", "t1"),
    ];

    // Snapshot before new user lands; only prior assistant available.
    const blocked = decideAssistantDelivery({
      state,
      turnId: "t2",
      turnInProgress: true,
      assistants: [{ id: "a1", text: "PR #102 is already merged…" }],
      messages,
      streaming: true,
      presentationFull: true,
    });
    expect(blocked.intent._tag).toBe("hold");
    expect(blocked.intent).toMatchObject({ reason: "assistant-already-finalized" });
    expect(blocked.state.phase).not.toBe("finalized");

    // Real time answer after new user + new assistant.
    const withTime = [
      ...messages,
      msg("u2", "user", "what's the time", "t2"),
      msg("a2", "assistant", "08:51 UTC", "t2"),
    ];
    const stream = decideAssistantDelivery({
      state,
      turnId: "t2",
      turnInProgress: true,
      assistants: [{ id: "a2", text: "08:51 UTC" }],
      messages: withTime,
      streaming: true,
      presentationFull: true,
    });
    expect(stream.intent._tag).toBe("stream");
    if (stream.intent._tag === "stream") {
      expect(stream.intent.text).toBe("08:51 UTC");
      expect(stream.intent.assistantId).toBe("a2");
    }

    const fin = settleFinalize(stream.state, {
      turnId: "t2",
      assistants: [{ id: "a2", text: "08:51 UTC" }],
      messages: withTime,
    });
    expect(fin.intent._tag).toBe("finalize");
    if (fin.intent._tag === "finalize") {
      expect(fin.intent.text).toBe("08:51 UTC");
    }
  });

  it("awaiting with no assistants holds (Working dots only)", () => {
    const state = beginDeliveryEpoch(initialDeliveryEpochState());
    const decision = decideAssistantDelivery({
      state,
      turnId: "t2",
      turnInProgress: true,
      assistants: [],
      streaming: true,
      presentationFull: true,
    });
    expect(decision.intent._tag).toBe("hold");

    const hb = decideHeartbeat({
      state: decision.state,
      turnInProgress: true,
      hasOpenTip: true,
    });
    expect(hb._tag).toBe("heartbeat");
    if (hb._tag === "heartbeat") {
      expect(hb.tipBody).toBe("");
    }
  });

  it("streaming epoch heartbeat may show stream text, never after finalize", () => {
    let state = beginDeliveryEpoch(initialDeliveryEpochState());
    const streamed = decideAssistantDelivery({
      state,
      turnId: "t1",
      turnInProgress: true,
      assistants: [{ id: "a1", text: "partial…" }],
      streaming: true,
      presentationFull: true,
    });
    state = streamed.state;
    const hb = decideHeartbeat({
      state,
      turnInProgress: true,
      hasOpenTip: true,
    });
    expect(hb).toEqual({
      _tag: "heartbeat",
      tipBody: "partial…",
      epoch: 1,
    });
  });
});
