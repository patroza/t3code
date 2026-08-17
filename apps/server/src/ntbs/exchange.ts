import type { ChatAttachment, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

/*
This file exposes the core model (data type and the business logic) of
`Exchange`s. An Exchange represent a two-way data bla bla.
*/

export type Request = {
  /**
   * Adapter-encoded URI locating the originating platform message,
   * e.g. `discord://<guildId>/<channelId>/<messageId>` or
   * `jira://<issueKey>/comment/<commentId>`.
   *
   * Two contracts:
   *
   * Identity — the same platform request must carry the same string
   * across redeliveries and restarts; distinct requests must carry
   * distinct strings. This is the durable dedup key `findByRequest`
   * looks up, the key the processor serializes concurrent deliveries
   * on, and the natural unique key for the adapter's stored records.
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
 * The base data type common to all member of ExchangeState
 */
type ExchangeStateBase = Request & {
  t3: {
    projectId: ProjectId;
    baseRef: string;
    // Planned while RequestClaimed; confirmed by ThreadCreated.

    /** The T3 thread created by the lifecycle event */
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
type RequestClaimed = ExchangeStateBase & {
  tag: "request-claimed";
};

/**
 * T3 has created the new thread and the adapter has recorded its relationship
 * to the platform request. The first turn may not have started yet.
 * Turn existence and progress are T3-owned.
 */
type ThreadCreated = ExchangeStateBase & {
  tag: "thread-created";
};

/**
 * T3 reached a terminal outcome; the exact reply payload is stored
 * verbatim so every posting attempt sends the same content.
 */
type ReplyPending = ExchangeStateBase & {
  tag: "reply-pending";
  reply: Reply;
};

/**
 * Terminal state.
 * The platform accepted the reply; its message ID is stored.
 */
type ReplyPosted = ExchangeStateBase & {
  tag: "reply-posted";
  reply: Reply;
  replySourceUri: string;
};

/**
 * Terminal state.
 * A finished reply exists but posting was given up after bounded attempts.
 * Stores the undelivered payload and the cause.
 * Common causes could be: the original discussion or message has been deleted
 * or locked (Jira/Github issue, Discord thread), the bot has been kicked, etc.
 * The tombstone keeps dedup intact and stops the processor from retrying together.
 */
type Undeliverable = ExchangeStateBase & {
  tag: "undeliverable";
  reply: Reply;
  cause: UndeliverableCause;
};

/**
 * The state of an exchange between an external platform and T3, from thread
 * creation through final-reply delivery. Adapters store the latest state to
 * track progress and resume incomplete exchanges after a restart.
 */
export type ExchangeState =
  | RequestClaimed
  | ThreadCreated
  | ReplyPending
  | ReplyPosted
  | Undeliverable;

/*
Decider/Policy pattern.

Let's compare the command/reducer pattern with the decider/policy one.

The command/reducer pattern is about applying mechanical and deterministic changes to a state of the program, via a command, to get the new state.

reducer: (currentState, command) -> state

The command expresses intent, and the reducer owns state transitions. In the command/reducer pattern we already know what should happen with the state, we only need to define how.

A different pattern to the previous one is presented by the **policy/decider** pattern. Here, the goal is not to decide the next state of the program, but to answer: given this state, and this context, what should be the next action/command?

decider: (state, content) -> command

The decider/policy pattern is important in the NTBS module because we have to frequently ask:
"given this information I have about the exchange and this context (e.g. checking external platforms or t3 thread states) what should we do next?"

This can be later combined with the reducer pattern again to describe the reconciliation flow:
1. load state               effect
2. retrieve observations    effect
3. make decision            pure
4. execute decision         effect
5. persist resulting state  effect
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

export type FromRequestClaimed = (input: {
  readonly state: RequestClaimed;
  readonly context: RequestClaimedContext;
}) => RequestClaimedDecision;

// TODO: Continue from here implementing the business logic

export const fromRequestClaimed: FromRequestClaimed = (input) => ({});

export type FromThreadCreated = (input: {
  readonly state: ThreadCreated;
  readonly context: ThreadCreatedContext;
}) => ThreadCreatedDecision;

export type FromReplyPending = (input: {
  readonly state: ReplyPending;
  readonly context: ReplyPendingContext;
}) => ReplyPendingDecision;
