import type { ChatAttachment, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

/*
This file defines the durable state and pure business rules for an exchange:
one admitted external request, its T3 work, and delivery of the eventual reply back to the originating platform.
*/

export type Request = {
  /**
   * Adapter-encoded URI locating the originating platform message,
   * e.g. `discord://<guildId>/<channelId>/<messageId>` or
   * `jira://<cloudId>/issue/<issueKey>/comment/<commentId>`.
   *
   * Two contracts:
   *
   * Identity — the same platform request must carry the same string
   * across redeliveries and restarts; distinct requests must carry
   * distinct strings. This is the durable dedup key `findBySourceUri`
   * looks up, the key the processor serializes concurrent deliveries
   * on, and the natural unique key for the repository's stored records.
   *
   * Addressability — it must contain everything needed to reach the
   * message through the platform API from a cold start, because
   * recovery reposts with only the stored record. A Discord message
   * ID alone fails this: replying requires the channel ID too.
   *
   * Only the adapter that wrote it may parse it; the processor treats
   * it as an opaque string.
   */
  readonly sourceUri: string;
  /**
   * The captured source text sent as the first T3 user message.
   * Platform independent.
   * Must not exceed T3's 120,000-character input limit.
   */
  readonly snapshot: string;
  /**
   * References to attachments stored by T3 and sent with the first user message.
   * The processor creates them from attachment data provided by the adapter.
   */
  readonly attachments: ReadonlyArray<ChatAttachment>;
};

export type Reply = {
  readonly type: "answer" | "failure" | "cancellation";
  readonly text: string;
};

export type UndeliverableCause = {
  readonly message: string;
};

/**
 * The base data type common to all members of ExchangeState
 */
export type ExchangeStateBase = Request & {
  readonly t3: {
    readonly projectId: ProjectId;
    readonly baseRef: string;
    // Planned while RequestClaimed; confirmed by ThreadCreated.
    readonly threadId: ThreadId;
    /**
     * The first T3 user message created for this external request.
     * This identifies the correct turn and reply even if the thread later
     * receives other messages.
     */
    readonly userMessageId: MessageId;
    readonly branchName: string;
  };
};

/**
 * The platform inbound code (Jira Webhook e.g.) admitted the request,
 * trigger and actor checks passed, and the processor records the request
 * as being claimed by the system.
 *
 * From here, the processor alone drives the exchange to a terminal state.
 */
export type RequestClaimed = ExchangeStateBase & {
  readonly tag: "request-claimed";
};

/**
 * The planned T3 thread exists. The first turn may not have started yet. Turn existence and progress are T3-owned.
 */
export type ThreadCreated = ExchangeStateBase & {
  readonly tag: "thread-created";
};

/**
 * T3 reached a terminal outcome; the exact reply payload is stored
 * verbatim so every posting attempt sends the same content.
 * This state may also follow `RequestClaimed` directly after a definitive provisioning failure, so it and later states do not imply the thread existed.
 * Reply delivery needs only `sourceUri`.
 */
export type ReplyPending = ExchangeStateBase & {
  readonly tag: "reply-pending";
  readonly reply: Reply;
};

/**
 * Terminal state.
 * The platform accepted the reply; its message ID is stored.
 */
export type ReplyPosted = ExchangeStateBase & {
  readonly tag: "reply-posted";
  readonly reply: Reply;
  readonly replySourceUri: string;
};

/**
 * Terminal state.
 * A finished reply exists, but the platform definitively rejected delivery.
 * Stores the undelivered payload and the cause.
 * Common causes could be: the original discussion or message has been deleted
 * or locked (Jira/Github issue, Discord thread), the bot has been kicked, etc.
 * The tombstone keeps dedup intact and stops the processor from retrying forever.
 */
export type Undeliverable = ExchangeStateBase & {
  readonly tag: "undeliverable";
  readonly reply: Reply;
  readonly cause: UndeliverableCause;
};

/** States for exchanges that still have work left to do. */
export type NonTerminalExchangeState = RequestClaimed | ThreadCreated | ReplyPending;

/** States for exchanges that have finished, with the reply either posted or undeliverable. */
export type TerminalExchangeState = ReplyPosted | Undeliverable;

/**
 * The state of an exchange between an external platform and T3, from request
 * claim through final-reply delivery. The exchange repository stores the latest
 * state to track progress and resume non-terminal exchanges after a restart.
 */
export type ExchangeState = NonTerminalExchangeState | TerminalExchangeState;

export const isTerminalState = (state: ExchangeState): state is TerminalExchangeState => {
  // An exhaustive switch makes new lifecycle states require an explicit classification.
  // This way it is impossible to break the program semantics by adding a new state
  // and forgetting to deal with it, because it would not typecheck.
  switch (state.tag) {
    case "reply-posted":
    case "undeliverable":
      return true;

    case "request-claimed":
    case "thread-created":
    case "reply-pending":
      return false;
  }
};

export const isNonTerminalState = (state: ExchangeState): state is NonTerminalExchangeState =>
  !isTerminalState(state);

export const makeRequestClaimed = (input: Omit<RequestClaimed, "tag">): RequestClaimed => ({
  ...input,
  tag: "request-claimed",
});

/*
Decider/Policy pattern.

The decider answers: given the stored state and the relevant live context,
what should happen next?

decider: (state, context) -> action

The decider/policy pattern is important in the NTBS module because we have to frequently ask:
"given this information I have about the exchange and this context (e.g. checking external platforms or t3 thread states) what should we do next?"

A decision does not transition the exchange. The processor first executes the
chosen effect; only after it succeeds does the processor construct the legal
transition, passing along any result data the effect produced.
The reconciliation flow is:

1. load state                                  effect
2. retrieve observations                       effect
3. make decision                               pure
4. execute decision                            effect
5. construct the transition from its result    pure, then persist as an effect
*/

export type RequestClaimedContext = { readonly thread: "missing" } | { readonly thread: "present" };

export type ThreadCreatedContext =
  | {
      readonly turn: "missing";
    }
  | { readonly turn: "active" }
  | { readonly turn: "completed"; readonly reply: Reply };

export type ReplyPendingContext =
  | {
      readonly platformReply: "missing";
    }
  | {
      readonly platformReply: "posted";
      readonly replySourceUri: string;
    };

export const toThreadCreated = (state: RequestClaimed): ThreadCreated => ({
  ...state,
  tag: "thread-created",
});

export const toReplyPending = (
  state: RequestClaimed | ThreadCreated,
  reply: Reply,
): ReplyPending => ({
  ...state,
  tag: "reply-pending",
  reply,
});

export const toReplyPosted = (state: ReplyPending, replySourceUri: string): ReplyPosted => ({
  ...state,
  tag: "reply-posted",
  replySourceUri,
});

export const toUndeliverable = (state: ReplyPending, cause: UndeliverableCause): Undeliverable => ({
  ...state,
  tag: "undeliverable",
  cause,
});

export type RequestClaimedDecision =
  | { readonly type: "provision-thread" }
  | { readonly type: "record-thread-created" };

export type ThreadCreatedDecision =
  | { readonly type: "start-turn" }
  | { readonly type: "wait" }
  | {
      readonly type: "record-reply-pending";
      readonly reply: Reply;
    };

export type ReplyPendingDecision =
  | { readonly type: "post-reply" }
  | {
      readonly type: "record-reply-posted";
      readonly replySourceUri: string;
    };

export const fromRequestClaimed = (
  _state: RequestClaimed,
  context: RequestClaimedContext,
): RequestClaimedDecision =>
  context.thread === "missing" ? { type: "provision-thread" } : { type: "record-thread-created" };

export const fromThreadCreated = (
  _state: ThreadCreated,
  context: ThreadCreatedContext,
): ThreadCreatedDecision => {
  switch (context.turn) {
    case "missing":
      return { type: "start-turn" };

    case "active":
      return { type: "wait" };

    case "completed":
      return {
        type: "record-reply-pending",
        reply: context.reply,
      };
  }
};

export const fromReplyPending = (
  _state: ReplyPending,
  context: ReplyPendingContext,
): ReplyPendingDecision => {
  switch (context.platformReply) {
    case "missing":
      return { type: "post-reply" };

    case "posted":
      return {
        type: "record-reply-posted",
        replySourceUri: context.replySourceUri,
      };
  }
};
