/**
 * Pure delivery state machine for whether a chat adapter streams, finalizes, or heartbeats.
 * Each new user Working ack advances the epoch through awaiting, streaming, and finalized phases.
 * Finalized epochs stay quiet until later assistant content or same-message growth reopens them.
 * Effect integration stays in ResponseBridge.
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
 * Drop the finalized bubble and earlier assistants, except same-id text growth that replaces a premature finalize.
 * If the watermark is outside the retained tip, only gate its exact id; dropping the whole tip can deadlock delivery.
 * The follower's `resume-after` mode and turn selection handle old-final replay after reconnect.
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
 * Prefer current-turn assistants; never fall back to prior-turn bodies while a turn is running.
 * For settled snapshots, use after-last-user for catch-up (also when messages lack turn IDs); if a newer user follows
 * matched assistants, start after that user. Always apply the finalized-message watermark, reopening same-id growth.
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
      // Hold empty until this turn has assistant content; falling back would re-stream a prior final under Working.
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

const LIVE_TURN_STATUSES = new Set(["preparing", "starting", "running", "waiting"]);

/** Run ids that still own a visible response. Shared by Discord and Teams. */
export function liveTurnIds(
  runStatuses: ReadonlyArray<{ readonly id: string; readonly status: string }> | null | undefined,
): ReadonlyArray<string> {
  if (runStatuses == null) return [];
  return runStatuses.filter((run) => LIVE_TURN_STATUSES.has(run.status)).map((run) => run.id);
}

/** A prior turn may still owe Discord a final after queue drain advances `latestTurn`.
 * Catch up that answer separately; a live turn keeps its latest bubble on the editable progress message.
 */
export function unfinalizedPriorAssistantForCatchUp(input: {
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: string;
    readonly turnId: string | null;
    readonly text: string;
  }>;
  readonly currentTurnId: string | null;
  readonly lastFinalizedAssistantId: string | null;
  readonly lastFinalizedText?: string | null;
  /**
   * Turns still preparing, running, or waiting. Their bubbles stay on the
   * editable progress message. Catch-up must not post each one as a final
   * when a later cancelled run is briefly selected as current.
   */
  readonly liveTurnIds?: ReadonlyArray<string>;
}): {
  readonly id: string;
  readonly text: string;
  readonly turnId: string | null;
} | null {
  const { messages, currentTurnId } = input;
  const lastFinalizedText = input.lastFinalizedText ?? null;
  let prior: {
    readonly id: string;
    readonly text: string;
    readonly turnId: string | null;
  } | null = null;
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    if (currentTurnId !== null && message.turnId === currentTurnId) continue;
    const text = message.text.trimEnd();
    if (text === "" || (/^_Working/i.test(text) && text.length < 40)) continue;
    prior = { id: message.id, text: message.text, turnId: message.turnId };
  }
  if (prior === null) return null;

  if (prior.turnId !== null && (input.liveTurnIds ?? []).includes(prior.turnId)) return null;

  const remaining = excludeFinalizedAssistants({
    messages,
    assistants: [prior],
    lastFinalizedAssistantId: input.lastFinalizedAssistantId,
    lastFinalizedText,
  });
  return remaining[0] ?? null;
}

/**
 * Keep a substantial unfinalized stream body when the epoch enters awaiting
 * (fresh Working / next turn with no assistants yet). Wiping it here used to
 * drop the prior answer on queue drain before the next turn streamed.
 */
export function retainUnfinalizedStreamText(input: {
  readonly phase: DeliveryPhase;
  readonly streamText: string;
  readonly priorLastAssistantText: string;
}): string {
  if (input.phase === "streaming" && input.streamText.trim() !== "") {
    return input.streamText;
  }
  const prior = input.priorLastAssistantText.trim();
  const awaitingOrEmptyStream =
    input.phase === "awaiting" || (input.phase === "streaming" && input.streamText.trim() === "");
  if (awaitingOrEmptyStream && prior !== "" && !(/^_Working/i.test(prior) && prior.length < 40)) {
    return input.priorLastAssistantText;
  }
  if (input.phase === "awaiting") return "";
  if (input.phase === "streaming") return input.streamText;
  return input.priorLastAssistantText;
}

export function deliveryTextFromAssistants(
  assistants: ReadonlyArray<{ readonly text: string }>,
  mode: "progress" | "answer",
): string {
  const texts = assistants
    .map((message) => message.text.trimEnd())
    .filter((text) => text.trim() !== "");
  if (texts.length === 0) return "";
  // Progress is a replaceable status, not a transcript. Provider bubbles change IDs
  // within one turn; showing the latest nonempty bubble keeps one editable tip.
  if (mode === "progress" || texts.length === 1) return texts.at(-1)!;

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
 * Decide whether Discord streams, finalizes, or heartbeats for this snapshot.
 * Never redeliver finalized assistants or heartbeat after finalize; new content or same-id growth reopens the epoch.
 * The first idle snapshot gets settle grace; the second finalizes short status lines that stopped growing.
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

  // Give short idle status lines one snapshot to grow; finalize substantial answers immediately.
  // Skip grace during catch-up when no second snapshot will arrive, avoiding stale-final replay under Working.
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

/** Unfinished work includes waiting; presentation must not imply active execution. */
export function chatProgressLabel(input: {
  readonly runStatus: string | null | undefined;
  readonly hasPendingApprovals: boolean;
}) {
  if (input.hasPendingApprovals) return "Waiting for approval";
  if (input.runStatus === "waiting") return "Waiting";
  if (input.runStatus === "preparing" || input.runStatus === "starting") return "Starting";
  return "Working";
}
