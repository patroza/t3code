import { describe, expect, it } from "@effect/vitest";

import {
  GROK_UNKNOWN_MODEL,
  initialCodexScanState,
  initialGrokScanState,
  initialKimiScanState,
  KIMI_UNKNOWN_MODEL,
  parseClaudeLine,
  parseCodexLine,
  parseGrokLine,
  parseKimiLine,
  totalTokens,
} from "./usageTranscripts.ts";

/** Shaped after a real Claude Code assistant record. */
function claudeLine(overrides: {
  messageId: string;
  contentType: string;
  model?: string;
  outputTokens?: number;
}): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-07T04:05:13.944Z",
    sessionId: "5a128faa-8253-489e-b935-6c08e8e670c0",
    cwd: "/home/theo/project",
    message: {
      id: overrides.messageId,
      role: "assistant",
      model: overrides.model ?? "claude-fable-5",
      content: [{ type: overrides.contentType }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 66818,
        cache_read_input_tokens: 1000,
        output_tokens: overrides.outputTokens ?? 286,
      },
    },
  });
}

describe("parseClaudeLine", () => {
  it("extracts token totals and a dedupe key", () => {
    const record = parseClaudeLine(claudeLine({ messageId: "msg_1", contentType: "text" }));

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("claude");
    expect(record?.model).toBe("claude-fable-5");
    expect(record?.totals).toEqual({
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 66818,
      outputTokens: 286,
      reasoningTokens: 0,
    });
    expect(record?.dedupeKey).toBe("msg_1:");
  });

  it("gives every content block of one message the same dedupe key", () => {
    // T3 Code writes one record per content block, each repeating the parent
    // message's full usage. Summing them would overcount ~2.4x on real data.
    const text = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "text" }));
    const toolUse = parseClaudeLine(claudeLine({ messageId: "msg_2", contentType: "tool_use" }));

    expect(text?.dedupeKey).toBe(toolUse?.dedupeKey);
    expect(text?.totals).toEqual(toolUse?.totals);
  });

  it("ignores records that are not assistant messages", () => {
    expect(parseClaudeLine(JSON.stringify({ type: "user", message: {} }))).toBeNull();
    expect(parseClaudeLine("not json")).toBeNull();
  });
});

describe("parseCodexLine", () => {
  const sessionMeta = JSON.stringify({
    type: "session_meta",
    timestamp: "2026-08-01T05:17:41.289Z",
    payload: { type: "session_meta", id: "019fbbc1-b12c-7360-a685-28c181f0025f" },
  });
  const turnContext = JSON.stringify({
    type: "turn_context",
    timestamp: "2026-08-01T05:17:42.694Z",
    payload: { type: "turn_context", model: "gpt-5.6-sol" },
  });
  const tokenCount = (inputTokens: number, cached: number, output: number, reasoning: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: "2026-08-01T05:17:49.919Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: inputTokens,
            cached_input_tokens: cached,
            cache_write_input_tokens: 0,
            output_tokens: output,
            reasoning_output_tokens: reasoning,
          },
        },
      },
    });

  it("attributes usage to the model from the preceding turn context", () => {
    const state = initialCodexScanState();
    parseCodexLine(sessionMeta, state);
    parseCodexLine(turnContext, state);
    const record = parseCodexLine(tokenCount(19239, 11008, 299, 116), state);

    expect(record?.provider).toBe("codex");
    expect(record?.model).toBe("gpt-5.6-sol");
    expect(record?.sessionId).toBe("019fbbc1-b12c-7360-a685-28c181f0025f");
    // Codex reports input_tokens inclusive of the cached portion.
    expect(record?.totals.uncachedInputTokens).toBe(19239 - 11008);
    expect(record?.totals.cachedInputTokens).toBe(11008);
    expect(record?.totals.reasoningTokens).toBe(116);
  });

  it("skips a repeated token_count so deltas are not double counted", () => {
    const state = initialCodexScanState();
    parseCodexLine(turnContext, state);
    const first = parseCodexLine(tokenCount(100, 0, 10, 0), state);
    const repeat = parseCodexLine(tokenCount(100, 0, 10, 0), state);

    expect(first).not.toBeNull();
    expect(repeat).toBeNull();
  });

  it("drops usage that arrives before any model is known", () => {
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
  });

  it("does not let a pre-model event poison the duplicate signature", () => {
    // A token_count before its turn_context is dropped; the identical event
    // re-emitted once the model is known must still be counted.
    const state = initialCodexScanState();
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).toBeNull();
    parseCodexLine(turnContext, state);
    expect(parseCodexLine(tokenCount(100, 0, 10, 0), state)).not.toBeNull();
  });
});

describe("parseGrokLine", () => {
  // Shapes copied from a real ~/.grok/logs/unified.jsonl.
  const modelChanged = (sid: string, model: string) =>
    JSON.stringify({
      ts: "2026-08-07T05:33:50.526Z",
      lvl: "info",
      msg: "model changed",
      sid,
      ctx: { model },
    });
  const inferenceDone = (
    sid: string,
    ctx: Record<string, number>,
    ts = "2026-08-07T05:33:56.946Z",
  ) => JSON.stringify({ ts, lvl: "info", msg: "shell.turn.inference_done", sid, ctx });

  it("reads one record per inference, splitting cached out of the prompt total", () => {
    const state = initialGrokScanState();
    expect(parseGrokLine(modelChanged("s1", "grok-4.5"), state)).toBeNull();

    const record = parseGrokLine(
      inferenceDone("s1", {
        prompt_tokens: 23518,
        cached_prompt_tokens: 7808,
        completion_tokens: 184,
        reasoning_tokens: 56,
      }),
      state,
    );

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("grok");
    expect(record?.model).toBe("grok-4.5");
    expect(record?.sessionId).toBe("s1");
    // prompt_tokens is inclusive of the cached portion, so uncached is the
    // difference — adding both would double count the cache read.
    expect(record?.totals.uncachedInputTokens).toBe(23518 - 7808);
    expect(record?.totals.cachedInputTokens).toBe(7808);
    expect(record?.totals.outputTokens).toBe(184);
    expect(record?.totals.reasoningTokens).toBe(56);
    expect(record?.reportedCostUsd).toBeNull();
  });

  it("attributes interleaved sessions to their own models", () => {
    // The unified log is process-wide: a single carried model would credit
    // one session's turns to whichever session switched model last.
    const state = initialGrokScanState();
    parseGrokLine(modelChanged("s1", "grok-4.5"), state);
    parseGrokLine(modelChanged("s2", "grok-code"), state);

    const usage = { prompt_tokens: 100, cached_prompt_tokens: 0, completion_tokens: 10 };
    expect(parseGrokLine(inferenceDone("s1", usage), state)?.model).toBe("grok-4.5");
    expect(parseGrokLine(inferenceDone("s2", usage), state)?.model).toBe("grok-code");
  });

  it("keeps usage whose session never announced a model, as unpriceable", () => {
    // `model changed` leads a session, so this only happens if the log rotates
    // mid-session. Dropping the record would lose real tokens outright.
    const state = initialGrokScanState();
    const record = parseGrokLine(
      inferenceDone("s1", { prompt_tokens: 100, cached_prompt_tokens: 0, completion_tokens: 10 }),
      state,
    );

    expect(record).not.toBeNull();
    expect(record?.model).toBe(GROK_UNKNOWN_MODEL);
    expect(record?.totals.uncachedInputTokens).toBe(100);
  });

  it("never reports reasoning above the output it is drawn from", () => {
    const state = initialGrokScanState();
    parseGrokLine(modelChanged("s1", "grok-4.5"), state);
    const record = parseGrokLine(
      inferenceDone("s1", {
        prompt_tokens: 100,
        cached_prompt_tokens: 0,
        completion_tokens: 10,
        reasoning_tokens: 999,
      }),
      state,
    );
    expect(record?.totals.reasoningTokens).toBe(10);
  });

  it("ignores the log's other events", () => {
    const state = initialGrokScanState();
    parseGrokLine(modelChanged("s1", "grok-4.5"), state);
    expect(
      parseGrokLine(
        JSON.stringify({
          ts: "2026-08-07T05:33:56.946Z",
          msg: "first_token",
          sid: "s1",
          ctx: { ttft_ms: 2542 },
        }),
        state,
      ),
    ).toBeNull();
    expect(parseGrokLine("not json", state)).toBeNull();
  });
});

describe("parseKimiLine", () => {
  // Shape copied from a real ~/.kimi/sessions/<hash>/<session>/wire.jsonl.
  const statusUpdate = (
    usage: Record<string, number>,
    messageId = "chatcmpl-0PaxSO2787FGCr5nPVWAxidi",
    timestamp = 1785096129.2452343,
  ) =>
    JSON.stringify({
      timestamp,
      message: {
        type: "StatusUpdate",
        payload: {
          context_usage: 0.0167,
          context_tokens: 17600,
          max_context_tokens: 1048576,
          token_usage: usage,
          message_id: messageId,
          plan_mode: false,
          mcp_status: null,
        },
      },
    });

  it("reads a served response's counts and takes the session from the caller", () => {
    const state = initialKimiScanState("15f9b4f3-af5d-4939-9a82-c4ca191b5d58");
    const record = parseKimiLine(
      statusUpdate({
        input_other: 15296,
        output: 129,
        input_cache_read: 2304,
        input_cache_creation: 0,
      }),
      state,
    );

    expect(record).not.toBeNull();
    expect(record?.provider).toBe("kimi");
    expect(record?.sessionId).toBe("15f9b4f3-af5d-4939-9a82-c4ca191b5d58");
    expect(record?.totals.uncachedInputTokens).toBe(15296);
    expect(record?.totals.cachedInputTokens).toBe(2304);
    expect(record?.totals.cacheCreationTokens).toBe(0);
    expect(record?.totals.outputTokens).toBe(129);
    // Epoch seconds, not milliseconds.
    expect(record?.timestampMs).toBe(1785096129245);
  });

  it("records no model so the turn prices as unpriced rather than a guess", () => {
    const state = initialKimiScanState("session");
    const record = parseKimiLine(statusUpdate({ input_other: 10, output: 5 }), state);
    expect(record?.model).toBe(KIMI_UNKNOWN_MODEL);
    expect(record?.reportedCostUsd).toBeNull();
  });

  it("carries message_id so a refreshed status is not counted twice", () => {
    const state = initialKimiScanState("session");
    const record = parseKimiLine(statusUpdate({ input_other: 10, output: 5 }, "msg-1"), state);
    expect(record?.dedupeKey).toBe("msg-1");
  });

  it("sums across turns, because each response re-bills its whole context", () => {
    // A second turn re-sends the grown context, so its input side legitimately
    // repeats the first turn's tokens — that is what was billed. Treating the
    // counts as a running session total and taking only the last would
    // undercount every turn before it.
    const state = initialKimiScanState("session");
    const first = parseKimiLine(
      statusUpdate({ input_other: 15296, output: 129, input_cache_read: 2304 }, "msg-1"),
      state,
    );
    const second = parseKimiLine(
      statusUpdate({ input_other: 15400, output: 240, input_cache_read: 2304 }, "msg-2"),
      state,
    );

    expect(first?.dedupeKey).toBe("msg-1");
    expect(second?.dedupeKey).toBe("msg-2");
    // Distinct responses, so nothing collapses them.
    expect(second?.totals.outputTokens).toBe(240);
  });

  it("gives a refreshed status the same dedupe key so it collapses", () => {
    // Kimi re-emits a status without a new round trip; both copies carry the
    // same message_id, which is what the caller de-duplicates on.
    const state = initialKimiScanState("session");
    const a = parseKimiLine(statusUpdate({ input_other: 100, output: 10 }, "msg-1"), state);
    const b = parseKimiLine(statusUpdate({ input_other: 100, output: 10 }, "msg-1"), state);

    expect(a?.dedupeKey).toBe("msg-1");
    expect(b?.dedupeKey).toBe(a?.dedupeKey);
  });

  it("ignores the wire log's other frames", () => {
    const state = initialKimiScanState("session");
    expect(
      parseKimiLine(JSON.stringify({ type: "metadata", protocol_version: "1.10" }), state),
    ).toBeNull();
    expect(
      parseKimiLine(
        JSON.stringify({
          timestamp: 1785096129.2,
          message: { type: "TurnBegin", payload: { user_input: "hi" } },
        }),
        state,
      ),
    ).toBeNull();
    expect(parseKimiLine("not json", state)).toBeNull();
  });

  it("drops a status update that carries no tokens", () => {
    const state = initialKimiScanState("session");
    expect(
      parseKimiLine(statusUpdate({ input_other: 0, output: 0, input_cache_read: 0 }), state),
    ).toBeNull();
  });
});

describe("totalTokens", () => {
  it("does not add reasoning on top of output", () => {
    expect(
      totalTokens({
        uncachedInputTokens: 10,
        cachedInputTokens: 20,
        cacheCreationTokens: 30,
        outputTokens: 40,
        reasoningTokens: 25,
      }),
    ).toBe(100);
  });
});
