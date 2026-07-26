/**
 * Structural Discord assistant delivery state machine.
 *
 * Band-aid flags (seededWorkingAckPending, finalizedTurnId, lastAssistantText) grew into
 * conflicting rules. This module is the single source of truth for *whether* Discord may
 * stream, finalize, or heartbeat — keyed by a monotonic **epoch** that advances on each
 * new user Working ack (and only then).
 *
 * Phases per epoch:
 *   awaiting  → Working tip exists, no assistant body for this epoch yet
 *   streaming → tip may show current-turn progress
 *   finalized → final message posted; **no** further stream/heartbeat until epoch bumps
 *               (unless a later assistant / grown text reopens — see settle grace)
 *
 * Effect integration stays in ResponseBridge; this file is pure and fully unit-tested.
 */

export type DeliveryPhase = "idle" | "awaiting" | "streaming" | "finalized";

export type DeliveryEpochState = {
  /** Monotonic; advances only on a new user Working ack. */
  readonly epoch: number;
  readonly phase: DeliveryPhase;
  /** Turn id bound to this epoch once known. */
  readonly turnId: string | null;
  /** Assistant id currently (or last) streamed in this epoch. */
  readonly assistantId: string | null;
  /** Last text applied to the stream tip this epoch (never used after finalized). */
  readonly streamText: string;
  /**
   * Assistant id whose final answer was posted for this epoch (or the previous one
   * until a new epoch begins). Survives epoch bump as `lastFinalizedAssistantId`.
   */
  readonly finalizedAssistantId: string | null;
  /** Durable-style memory of the last assistant we successfully finalized (any epoch). */
  readonly lastFinalizedAssistantId: string | null;
  /**
   * Text of the last successful Discord final (any epoch). Used to reopen when the
   * **same** assistant id grows after a premature finalize (status line → full answer).
   */
  readonly lastFinalizedText: string | null;
  /**
   * Settle grace: multi-step agents often flip turn idle for one snapshot between a
   * short status bubble and the real answer. Require one settled confirmation before
   * finalize so we do not lock the epoch on "Checking PR…" style status lines.
   */
  readonly settleReady: boolean;
};

export type DeliveryIntent =
  | { readonly _tag: "noop"; readonly reason: string }
  | { readonly _tag: "hold"; readonly reason: string }
  | {
      readonly _tag: "stream";
      readonly text: string;
      readonly turnId: string | null;
      readonly assistantId: string;
      readonly epoch: number;
    }
  | {
      readonly _tag: "finalize";
      readonly text: string;
      readonly turnId: string | null;
      readonly assistantId: string;
      readonly epoch: number;
    }
  | {
      readonly _tag: "heartbeat";
      /** Empty string → Working dots only. Never a prior final answer after finalize. */
      readonly tipBody: string;
      readonly epoch: number;
    };

export const initialDeliveryEpochState = (
  seed?: Partial<DeliveryEpochState>,
): DeliveryEpochState => ({
  epoch: seed?.epoch ?? 0,
  phase: seed?.phase ?? "idle",
  turnId: seed?.turnId ?? null,
  assistantId: seed?.assistantId ?? null,
  streamText: seed?.streamText ?? "",
  finalizedAssistantId: seed?.finalizedAssistantId ?? null,
  lastFinalizedAssistantId: seed?.lastFinalizedAssistantId ?? null,
  lastFinalizedText: seed?.lastFinalizedText ?? null,
  settleReady: seed?.settleReady ?? false,
});

/**
 * New user turn (Discord Working ack). Bumps epoch and enters awaiting.
 * Clears stream body so heartbeat cannot repaint the previous final answer.
 */
export function beginDeliveryEpoch(
  state: DeliveryEpochState,
  input?: { readonly turnId?: string | null },
): DeliveryEpochState {
  return {
    epoch: state.epoch + 1,
    phase: "awaiting",
    turnId: input?.turnId ?? null,
    assistantId: null,
    streamText: "",
    finalizedAssistantId: null,
    lastFinalizedAssistantId: state.lastFinalizedAssistantId,
    lastFinalizedText: state.lastFinalizedText,
    settleReady: false,
  };
}

/**
 * Drop assistants at or before the last Discord-finalized bubble.
 *
 * Race this prevents: new epoch + turnInProgress, but the snapshot still only has
 * prior-turn assistants (new user not in messages yet, or forTurn empty → afterLastUser
 * falls back to them). Without this filter we re-stream/re-finalize the previous answer
 * (e.g. "what's the time" re-posting PR #102).
 *
 * Multi-bubble prior turns: we only persist the last finalized id, so filtering by
 * message order (not just exact id match) drops the whole prior answer set.
 *
 * Same-id growth: if the finalized bubble's text grew past lastFinalizedText, keep it
 * so a premature status finalize can be replaced by the real answer on the same id.
 *
 * Cursor outside retained window: when `lastFinalizedAssistantId` is set but not present
 * in the message list, we **cannot** order the watermark vs the retained tip.
 * Treating the whole tip as already delivered (drop-all) deadlocks live threads whose
 * durable cursor points at an older bubble that rolled out of the tip — Discord stays
 * on `_Working.._` forever (`deliveryAssistants: 0`, `awaiting-first-assistant`).
 *
 * Missing cursor therefore only gates the exact finalized id (growth reopen); all other
 * assistant ids are kept. Reconnect re-post of old finals is handled by the thread
 * follower (`resume-after` skips warm re-seed) and by turnId / after-last-user selection
 * in `assistantMessagesForDelivery`.
 */
export function excludeFinalizedAssistants<
  T extends { readonly id: string; readonly text?: string },
>(input: {
  readonly messages: ReadonlyArray<{ readonly id: string }>;
  readonly assistants: ReadonlyArray<T>;
  readonly lastFinalizedAssistantId: string | null;
  readonly lastFinalizedText?: string | null;
}): ReadonlyArray<T> {
  const { messages, assistants, lastFinalizedAssistantId } = input;
  const lastFinalizedText = input.lastFinalizedText ?? null;
  if (lastFinalizedAssistantId === null || assistants.length === 0) return assistants;

  const finalizedIdx = messages.findIndex((message) => message.id === lastFinalizedAssistantId);
  if (finalizedIdx < 0) {
    // Cursor not in this tip/candidate list — keep new ids; only gate exact match.
    return assistants.filter((assistant) => {
      if (assistant.id !== lastFinalizedAssistantId) return true;
      return isGrownFinalizedText(assistant.text ?? "", lastFinalizedText);
    });
  }
  return assistants.filter((assistant) => {
    const idx = messages.findIndex((message) => message.id === assistant.id);
    if (idx > finalizedIdx) return true;
    if (assistant.id === lastFinalizedAssistantId) {
      return isGrownFinalizedText(assistant.text ?? "", lastFinalizedText);
    }
    return false;
  });
}

/** True when current text is a clear expansion of a prior premature final. */
export function isGrownFinalizedText(
  currentText: string,
  lastFinalizedText: string | null,
): boolean {
  const current = currentText.trimEnd();
  if (current === "") return false;
  if (lastFinalizedText === null) return false;
  const prior = lastFinalizedText.trimEnd();
  if (prior === "") return current.length >= 40;
  if (current === prior) return false;
  // Grown body: longer by a meaningful margin, or prior was a short status prefix.
  if (current.length >= Math.max(prior.length + 40, Math.ceil(prior.length * 1.5))) {
    return true;
  }
  if (
    prior.length <= 120 &&
    current.length > prior.length &&
    current.startsWith(prior.slice(0, 20))
  ) {
    return true;
  }
  return false;
}

/**
 * Assistants that may appear on Discord for this snapshot.
 *
 * Structural rules (in order):
 * 1. Prefer turnId match when the turn is still running (mid-turn steer keeps pre-steer).
 * 2. If a newer **user** message sits after every turnId-matched assistant and the turn
 *    is **not** running, treat that as the next Discord turn starting with a stale
 *    latestTurn — return only assistants after that user (usually empty).
 * 3. If turnId is set but no assistants match and the turn is **running**, return empty
 *    (never after-last-user prior bodies — that re-streams the previous final under
 *    `_Working.._` when a comment recovers the bridge before the new user lands).
 * 4. If turnId is set, no assistants match, and the turn is **settled**, prefer
 *    after-last-user for catch-up finalize (filter via lastFinalized).
 * 5. Fall back to after-last-user only when messages lack turn ids entirely.
 * 6. Always drop assistants at/before `lastFinalizedAssistantId` in message order
 *    (unless same-id text grew past lastFinalizedText).
 */
export function assistantMessagesForDelivery(input: {
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly turnId: string | null;
    readonly text: string;
  }>;
  readonly turnId: string | null;
  readonly turnInProgress: boolean;
  readonly hasLatestTurn: boolean;
  /** Durable id of the last assistant Discord successfully finalized (any epoch). */
  readonly lastFinalizedAssistantId?: string | null;
  readonly lastFinalizedText?: string | null;
}): ReadonlyArray<{
  readonly id: string;
  readonly role: string;
  readonly turnId: string | null;
  readonly text: string;
}> {
  const { messages, turnId, turnInProgress, hasLatestTurn } = input;
  const lastFinalizedAssistantId = input.lastFinalizedAssistantId ?? null;
  const lastFinalizedText = input.lastFinalizedText ?? null;
  void hasLatestTurn;

  let lastUserIdx = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIdx = index;
      break;
    }
  }
  const afterLastUser = (lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages).filter(
    (message) => message.role === "assistant",
  );

  let selected: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly turnId: string | null;
    readonly text: string;
  }>;

  if (turnId !== null) {
    const forTurn = messages.filter(
      (message) => message.role === "assistant" && message.turnId === turnId,
    );
    if (forTurn.length > 0) {
      const lastForTurn = forTurn[forTurn.length - 1]!;
      const lastForTurnIdx = messages.findLastIndex((message) => message.id === lastForTurn.id);
      // Stale latestTurn after a completed turn: a newer user message means a new Discord
      // turn is starting — never re-surface the completed turn's body.
      if (lastUserIdx > lastForTurnIdx && !turnInProgress) {
        selected = afterLastUser;
      } else {
        selected = forTurn;
      }
    } else if (turnInProgress) {
      // New turn has no assistants yet. Never fall back to prior-turn afterLastUser
      // bodies — that re-streams the previous final under _Working.._ + Stop when a
      // comment recovers the bridge before the new user message is in the snapshot
      // (or before lastFinalizedAssistantId is known). Hold empty until this turn
      // produces its own assistant content.
      selected = [];
    } else {
      // Settled catch-up: after-last-user only (usually the previous answer for finalize).
      // Finalized filter below strips already-delivered bubbles.
      selected = afterLastUser;
    }
  } else {
    selected = afterLastUser;
  }

  return excludeFinalizedAssistants({
    messages,
    assistants: selected,
    lastFinalizedAssistantId,
    lastFinalizedText,
  });
}

export function deliveryTextFromAssistants(
  assistants: ReadonlyArray<{ readonly text: string }>,
  mode: "progress" | "answer",
): string {
  const texts = assistants
    .map((message) => message.text.trimEnd())
    .filter((text) => text.trim() !== "");
  if (texts.length === 0) return "";
  if (mode === "progress" || texts.length === 1) return texts.join("\n\n").trimEnd();

  // Mirror finalAnswerText: prefer last bubble unless it is a short trailer after Findings.
  const last = texts[texts.length - 1]!;
  const longest = texts.reduce((a, b) => (a.length >= b.length ? a : b));
  const SHORT_TRAILER_MAX_CHARS = 400;
  if (
    longest.length >= 800 &&
    last.length < SHORT_TRAILER_MAX_CHARS &&
    last.length < longest.length * 0.35
  ) {
    return longest;
  }
  return last;
}

/**
 * Decide what Discord may do for this thread snapshot.
 *
 * Hard invariants:
 * - Never stream/finalize assistants at/before lastFinalizedAssistantId — even while
 *   turnInProgress (unless same-id text grew past lastFinalizedText).
 * - Heartbeat after finalize is always noop.
 * - `finalized` epoch reopens when a **new** assistant appears after lastFinalized, or
 *   the finalized bubble's text grew into a real answer.
 * - Settle grace: first idle snapshot with content streams/holds; second idle snapshot
 *   finalizes (avoids locking on multi-step status lines).
 */
export function decideAssistantDelivery(input: {
  readonly state: DeliveryEpochState;
  readonly turnId: string | null;
  readonly turnInProgress: boolean;
  readonly assistants: ReadonlyArray<{
    readonly id: string;
    readonly text: string;
  }>;
  readonly streaming: boolean;
  readonly presentationFull: boolean;
  /**
   * Full thread message order (optional). When provided with lastFinalizedAssistantId,
   * drops every assistant at/before that bubble — not only the exact id.
   */
  readonly messages?: ReadonlyArray<{ readonly id: string }>;
  /**
   * When true, skip the two-snapshot settle grace and finalize on the first idle snapshot.
   * Used for rehydrate/catch-up of already-settled turns so Discord does not leave a
   * permanent `_Working.. · N tool calls_` tip waiting for a second snapshot that never
   * arrives on idle threads.
   */
  readonly skipSettleGrace?: boolean;
}): { readonly state: DeliveryEpochState; readonly intent: DeliveryIntent } {
  const { turnId, turnInProgress, streaming, presentationFull } = input;
  const skipSettleGrace = input.skipSettleGrace === true;

  // Drop already-finalized bubbles first (works for both open and reopened epochs).
  const assistants = excludeFinalizedAssistants({
    messages: input.messages ?? input.assistants,
    assistants: input.assistants,
    lastFinalizedAssistantId: input.state.lastFinalizedAssistantId,
    lastFinalizedText: input.state.lastFinalizedText,
  });

  // After a premature finalize, late assistants after lastFinalized reopen delivery.
  let state = input.state;
  if (state.phase === "finalized") {
    if (assistants.length === 0) {
      return {
        state,
        intent: { _tag: "noop", reason: "epoch-finalized" },
      };
    }
    // Reopen same epoch so stream/finalize can post the real answer without a new Working ack.
    state = {
      ...state,
      phase: turnInProgress || streaming ? "streaming" : "awaiting",
      streamText: "",
      assistantId: null,
      finalizedAssistantId: null,
      settleReady: false,
    };
  }

  // In-progress work always resets settle grace.
  if (turnInProgress || streaming) {
    state = { ...state, settleReady: false };
  }

  const assistantId = assistants.at(-1)?.id ?? null;
  const progressText = deliveryTextFromAssistants(assistants, "progress");
  const answerText = deliveryTextFromAssistants(assistants, "answer");

  // Only already-finalized content was available (filtered out). Hold while the turn
  // is running / awaiting; when settled, noop without posting.
  if (assistants.length === 0 && input.assistants.length > 0) {
    if (turnInProgress || streaming || state.phase === "awaiting") {
      return {
        state: {
          ...state,
          phase: state.phase === "idle" ? "awaiting" : state.phase,
          turnId: turnId ?? state.turnId,
          settleReady: false,
        },
        intent: { _tag: "hold", reason: "assistant-already-finalized" },
      };
    }
    return {
      state,
      intent: { _tag: "noop", reason: "assistant-already-finalized" },
    };
  }

  // Awaiting Working: no assistant body for this epoch yet → hold.
  if (state.phase === "awaiting" && assistants.length === 0) {
    return {
      state: { ...state, turnId: turnId ?? state.turnId, settleReady: false },
      intent: { _tag: "hold", reason: "awaiting-first-assistant" },
    };
  }

  if (!presentationFull && streaming) {
    return { state, intent: { _tag: "noop", reason: "final-only-suppress-stream" } };
  }

  if (streaming || turnInProgress) {
    if (assistants.length === 0) {
      return {
        state: {
          ...state,
          phase: state.phase === "idle" ? "awaiting" : state.phase,
          turnId: turnId ?? state.turnId,
          settleReady: false,
        },
        intent: { _tag: "hold", reason: "in-progress-no-assistant-text" },
      };
    }
    if (assistantId === null) {
      return { state, intent: { _tag: "noop", reason: "missing-assistant-id" } };
    }
    const next: DeliveryEpochState = {
      ...state,
      phase: "streaming",
      turnId: turnId ?? state.turnId,
      assistantId,
      streamText: progressText,
      settleReady: false,
    };
    return {
      state: next,
      intent: {
        _tag: "stream",
        text: progressText,
        turnId: next.turnId,
        assistantId,
        epoch: state.epoch,
      },
    };
  }

  // Turn settled.
  if (assistants.length === 0 || answerText.trim() === "") {
    return {
      state,
      intent: { _tag: "noop", reason: "settled-without-content" },
    };
  }
  if (assistantId === null) {
    return { state, intent: { _tag: "noop", reason: "missing-assistant-id" } };
  }

  // Settle grace: first idle snapshot with *short* content keeps streaming the tip body
  // and arms settleReady (status lines like "Checking PR…" often grow into a real answer).
  // Substantial settled answers finalize immediately — otherwise recovery/rehydrate streams
  // the full previous final under `_Working.._` + Stop for one+ snapshots (or forever if a
  // new turn starts before the second idle tick).
  // Skip grace entirely on rehydrate/catch-up (`skipSettleGrace`) when no second snapshot.
  const SETTLE_GRACE_MAX_CHARS = 250;
  if (
    !state.settleReady &&
    !skipSettleGrace &&
    answerText.trim().length <= SETTLE_GRACE_MAX_CHARS
  ) {
    const next: DeliveryEpochState = {
      ...state,
      phase: "streaming",
      turnId: turnId ?? state.turnId,
      assistantId,
      streamText: answerText,
      settleReady: true,
    };
    return {
      state: next,
      intent: {
        _tag: "stream",
        text: answerText,
        turnId: next.turnId,
        assistantId,
        epoch: state.epoch,
      },
    };
  }

  const next: DeliveryEpochState = {
    ...state,
    phase: "finalized",
    turnId: turnId ?? state.turnId,
    assistantId,
    streamText: "",
    finalizedAssistantId: assistantId,
    lastFinalizedAssistantId: assistantId,
    lastFinalizedText: answerText,
    settleReady: false,
  };
  return {
    state: next,
    intent: {
      _tag: "finalize",
      text: answerText,
      turnId: next.turnId,
      assistantId,
      epoch: state.epoch,
    },
  };
}

/**
 * Heartbeat may only pulse while awaiting/streaming for the current epoch.
 * Never recreates Working after finalize (that produced final + Working duplicates).
 */
export function decideHeartbeat(input: {
  readonly state: DeliveryEpochState;
  readonly turnInProgress: boolean;
  readonly hasOpenTip: boolean;
}): Extract<DeliveryIntent, { readonly _tag: "noop" | "heartbeat" }> {
  const { state, turnInProgress } = input;
  if (state.phase === "finalized" || state.phase === "idle") {
    return { _tag: "noop", reason: "heartbeat-inactive-phase" };
  }
  if (!turnInProgress && state.phase !== "awaiting" && !state.settleReady) {
    return { _tag: "noop", reason: "heartbeat-turn-idle" };
  }
  // Awaiting: dots only. Streaming / settle-grace: may show streamText (current epoch only).
  const tipBody = state.phase === "awaiting" ? "" : state.streamText;
  // Note: the `finalized` phase is already short-circuited to a noop at the top of this
  // function, so no post-finalize recreate guard is reachable here.
  return { _tag: "heartbeat", tipBody, epoch: state.epoch };
}

/**
 * Whether a stream tip update failure should create a replacement tip.
 * Never after the epoch is finalized.
 */
export function shouldRecreateTip(input: {
  readonly state: DeliveryEpochState;
  readonly updateFailed: boolean;
  readonly turnInProgress: boolean;
}): boolean {
  if (!input.updateFailed) return false;
  if (!input.turnInProgress && !input.state.settleReady) return false;
  return input.state.phase === "awaiting" || input.state.phase === "streaming";
}
