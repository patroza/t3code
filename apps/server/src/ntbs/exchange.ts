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

export type ReplyFailure = {
  readonly type: "failure";
  readonly text: string;
  readonly cause: unknown;
};

export type ReplyCancellation = {
  readonly type: "cancellation";
  readonly text: string;
  readonly cause: unknown;
};

export type Reply =
  | {
      readonly type: "answer";
      readonly text: string;
    }
  | ReplyFailure
  | ReplyCancellation;

export type UndeliverableCause = {
  readonly message: string;
};

/** Stable identifiers and locations for an exchange's T3 work. */
export type WorkCoordinates = {
  readonly projectId: ProjectId;
  /**
   * The branch this work starts from, and the commit it pointed at on `origin`
   * when the request was claimed.
   * We keep the same SHA across retries so the request always runs against the
   * code selected when it was claimed, even if the branch moves later. The name
   * is recorded as the worktree's merge base for later diff and PR flows.
   */
  readonly startBranchName: string;
  readonly startCommitSha: string;
  // Planned while RequestClaimed; confirmed by ThreadCreated.
  readonly threadId: ThreadId;
  /**
   * The first T3 user message created for this external request.
   * This identifies the correct turn and reply even if the thread later
   * receives other messages.
   */
  readonly userMessageId: MessageId;
  /** The branch minted for this request's worktree. */
  readonly worktreeBranchName: string;
};

/**
 * The data every exchange carries, whatever state it has reached.
 */
export type ExchangeBase = Request & {
  readonly t3: WorkCoordinates;
};

/**
 * The platform inbound code (Jira Webhook e.g.) admitted the request,
 * trigger and actor checks passed, and the processor records the request
 * as being claimed by the system.
 *
 * From here, the processor alone drives the exchange to a terminal state.
 */
export type RequestClaimed = ExchangeBase & {
  readonly tag: "request-claimed";
};

/**
 * The planned T3 thread exists. The first turn may not have started yet. Turn existence and progress are T3-owned.
 */
export type ThreadCreated = ExchangeBase & {
  readonly tag: "thread-created";
};

/**
 * T3 reached a terminal outcome; the exact reply payload is stored
 * verbatim so every posting attempt sends the same content.
 * This state may also follow `RequestClaimed` directly after a definitive provisioning failure, so it and later states do not imply the thread existed.
 * Reply delivery needs only `sourceUri`.
 */
export type ReplyPending = ExchangeBase & {
  readonly tag: "reply-pending";
  readonly reply: Reply;
};

/**
 * Terminal state.
 * The platform accepted the reply; its message ID is stored.
 */
export type ReplyPosted = ExchangeBase & {
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
export type Undeliverable = ExchangeBase & {
  readonly tag: "undeliverable";
  readonly reply: Reply;
  readonly cause: UndeliverableCause;
};

/** Exchanges that still have work left to do. */
export type NonTerminalExchange = RequestClaimed | ThreadCreated | ReplyPending;

/** Exchanges that have finished, with the reply either posted or undeliverable. */
export type TerminalExchange = ReplyPosted | Undeliverable;

/**
 * One exchange between an external platform and T3, from request claim through
 * final-reply delivery. The tag says how far it got; the repository stores the
 * latest value per `sourceUri` so non-terminal exchanges resume after a restart.
 */
export type Exchange = NonTerminalExchange | TerminalExchange;

export const isTerminal = (state: Exchange): state is TerminalExchange => {
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

export const isNonTerminal = (state: Exchange): state is NonTerminalExchange => !isTerminal(state);

export const makeRequestClaimed = (
  request: Request,
  coordinates: WorkCoordinates,
): RequestClaimed => ({
  ...request,
  t3: coordinates,
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
