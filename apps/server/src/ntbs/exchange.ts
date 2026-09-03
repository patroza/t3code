import type { ChatAttachment, MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { Duration } from "effect";

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

/**
 * Describes _where_ the T3 work goes. Set by the platform-specific inbound code.
 */
export type T3Target = {
  readonly projectId: ProjectId;
  /**
   * The starting point for the thread's worktree: the new branch is created from this one.
   *
   * Must be a branch that exists on `origin`; it is resolved there, so the worktree starts from the
   * latest remote commit even when the local copy is behind. Tags, commit SHAs and local-only
   * branches are rejected.
   */
  readonly startBranchName: string;
};

/** Stable identifiers and locations for an exchange's T3 work. */
export type WorkCoordinates = {
  readonly projectId: ProjectId;
  /**
   * The branch this work starts from, and the commit it pointed at on `origin` when the work was planned.
   * We keep the same SHA across retries so the request always runs against the code selected when it was planned, even if the branch moves later. The name is recorded as the worktree's merge base for later diff and PR flows.
   */
  readonly startBranchName: string;
  readonly startCommitSha: string;
  // Planned while WorkPlanned; confirmed by ThreadCreated.
  readonly threadId: ThreadId;
  /**
   * The first T3 user message created for this external request.
   * This identifies the correct turn and reply even if the thread later receives other messages.
   */
  readonly userMessageId: MessageId;
  /** The branch minted for this request's worktree. */
  readonly worktreeBranchName: string;
};

/** Identifiers locating the T3 turn a reply came out of. */
export type TurnCoordinates = {
  readonly threadId: ThreadId;
  readonly userMessageId: MessageId;
  readonly turnId: TurnId;
};

/**
 * Why an exchange ended in a failure reply, with the T3 identifiers that existed when it happened.
 * Every variant is plain data so the stored reply survives JSON encoding; diagnostics that are not (the underlying error) are logged where the failure is caught, not stored.
 */
export type FailureCause =
  /**
   * T3 rejected the one action of the state the exchange was in; `method` names the T3 call that answered.
   * `state` is that state reduced to its T3 data: nothing for a rejected target, the planned coordinates otherwise.
   */
  | {
      readonly type: "rejected";
      readonly method: string;
      readonly state:
        | Pick<RequestAccepted, "tag">
        | Pick<WorkPlanned, "tag" | "t3">
        | Pick<ThreadCreated, "tag" | "t3">;
    }
  /** T3 settled the thread without an answer to our message; observed, not a rejection. `turnId` is null when no turn ever adopted the message. */
  | {
      readonly type: "settled";
      readonly threadId: ThreadId;
      readonly userMessageId: MessageId;
      readonly turnId: TurnId | null;
    }
  /** The state outlived its deadline and its action was given up. `state` is reduced like in `rejected`. */
  | {
      readonly type: "expired";
      readonly state:
        | Pick<RequestAccepted, "tag">
        | Pick<WorkPlanned, "tag" | "t3">
        | Pick<ThreadCreated, "tag" | "t3">;
    };

export type ReplyAnswer = TurnCoordinates & {
  readonly type: "answer";
  readonly text: string;
};

export type ReplyFailure = {
  readonly type: "failure";
  readonly text: string;
  readonly cause: FailureCause;
};

export type ReplyCancellation = TurnCoordinates & {
  readonly type: "cancellation";
  readonly text: string;
};

/**
 * What gets posted back to the platform. Each variant carries the T3 context that produced it, so delivery and audit need nothing else from the exchange.
 */
export type Reply = ReplyAnswer | ReplyFailure | ReplyCancellation;

export type UndeliverableCause = {
  readonly message: string;
};

/**
 * The data every exchange carries, whatever state it has reached: the request and where its work was meant to go.
 */
export type ExchangeBase = Request & {
  readonly target: T3Target;
  /** Epoch millis of when the request was recorded, which is when it was accepted. */
  readonly createdAt: number;
  /**
   * Epoch millis of the last transition.
   * The processor never rewrites a state in place, so this is when the current state began.
   */
  readonly updatedAt: number;
};

/**
 * The platform inbound code (Jira Webhook e.g.) admitted the request,
 * trigger and actor checks passed, and the processor recorded it.
 *
 * Nothing in T3 exists yet. From here, the processor alone drives the exchange to a terminal state, and everything that fails from here on becomes a failure reply like any other.
 */
export type RequestAccepted = ExchangeBase & {
  readonly tag: "request-accepted";
};

/**
 * T3 accepted the target and the identifiers for its work are minted and stored.
 * Still nothing created in T3: the thread, worktree and turn come next.
 */
export type WorkPlanned = ExchangeBase & {
  readonly tag: "work-planned";
  readonly t3: WorkCoordinates;
};

/**
 * The planned T3 thread exists. The first turn may not have started yet. Turn existence and progress are T3-owned.
 */
export type ThreadCreated = ExchangeBase & {
  readonly tag: "thread-created";
  readonly t3: WorkCoordinates;
};

/**
 * A reply exists; the exact payload is stored verbatim so every posting attempt sends the same content.
 * Reached from any earlier state: a rejection during planning, provisioning or turn start lands here as much as a finished turn does, so this and later states do not imply the thread existed.
 * Delivery needs only `sourceUri` and the reply; what T3 produced it lives inside the reply.
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
export type NonTerminalExchange = RequestAccepted | WorkPlanned | ThreadCreated | ReplyPending;

/** Exchanges that have finished, with the reply either posted or undeliverable. */
export type TerminalExchange = ReplyPosted | Undeliverable;

/**
 * One exchange between an external platform and T3, from request acceptance through
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

    case "request-accepted":
    case "work-planned":
    case "thread-created":
    case "reply-pending":
      return false;
  }
};

export const isNonTerminal = (state: Exchange): state is NonTerminalExchange => !isTerminal(state);

/** The states an exchange may move to from each state; the same table the constructors below enforce in types. */
const successors: { readonly [Tag in Exchange["tag"]]: ReadonlyArray<Exchange["tag"]> } = {
  "request-accepted": ["work-planned", "reply-pending"],
  "work-planned": ["thread-created", "reply-pending"],
  "thread-created": ["reply-pending"],
  "reply-pending": ["reply-posted", "undeliverable"],
  "reply-posted": [],
  undeliverable: [],
};

/**
 * Whether `next` is a later version of the same exchange as `previous`: the same state rewritten, or a state the exchange may legally move to. Going back, skipping ahead, and moving a terminal exchange are all refused.
 */
export const isUpdateOf = (next: Exchange, previous: Exchange): boolean =>
  next.sourceUri === previous.sourceUri &&
  (next.tag === previous.tag || successors[previous.tag].includes(next.tag));

/**
 * How long an exchange may stay in each non-terminal state, in millis, before its action is given up.
 * First guesses: planning and provisioning fail on git and the filesystem, a turn on the agent, delivery on the platform.
 */
const deadlines: { readonly [Tag in NonTerminalExchange["tag"]]: number } = {
  "request-accepted": Duration.toMillis(Duration.minutes(5)),
  "work-planned": Duration.toMillis(Duration.minutes(15)),
  "thread-created": Duration.toMillis(Duration.hours(1)),
  "reply-pending": Duration.toMillis(Duration.hours(1)),
};

/** Whether the current state is older than its deadline. */
export const isExpired = (state: NonTerminalExchange, now: number): boolean =>
  now - state.updatedAt > deadlines[state.tag];

const getFailureThreadId = (cause: FailureCause): ThreadId | null => {
  switch (cause.type) {
    case "settled":
      return cause.threadId;

    case "rejected":
    case "expired":
      return "t3" in cause.state ? cause.state.t3.threadId : null;
  }
};

const getReplyThreadId = (reply: Reply): ThreadId | null => {
  switch (reply.type) {
    case "answer":
    case "cancellation":
      return reply.threadId;

    case "failure":
      return getFailureThreadId(reply.cause);
  }
};

/**
 * The T3 thread this exchange refers to, wherever the state keeps it: in `t3` while work is in  progress, inside the reply afterwards. Null before planning and when planning was rejected.
 */
export const getThreadId = (exchange: Exchange): ThreadId | null => {
  switch (exchange.tag) {
    case "request-accepted":
      return null;

    case "work-planned":
    case "thread-created":
      return exchange.t3.threadId;

    case "reply-pending":
    case "reply-posted":
    case "undeliverable":
      return getReplyThreadId(exchange.reply);
  }
};

export const makeRequestAccepted = (
  request: Request,
  target: T3Target,
  now: number,
): RequestAccepted => ({
  ...request,
  target,
  createdAt: now,
  updatedAt: now,
  tag: "request-accepted",
});

/*
Decider/Policy pattern.

The decider answers: given the stored state and the relevant live context, what should happen next?

decider: (state, context) -> action

The decider/policy pattern is important in the NTBS module because we have to frequently ask: "given this information I have about the exchange and this context (e.g. checking external platforms or t3 thread states) what should we do next?"

A decision does not transition the exchange. The processor first executes the chosen effect; only after it succeeds does the processor construct the legal transition, passing along any result data the effect produced.
The reconciliation flow is:

1. load state                                  effect
2. retrieve observations                       effect
3. make decision                               pure
4. execute decision                            effect
5. construct the transition from its result    pure, then persist as an effect

Every decider also receives the current time. When the observation shows the state's action is still needed and the state is past its deadline, the decision is to expire instead. An observation that completes the state wins over expiry, so a late result is still recorded.
RequestAccepted observes nothing but the clock: planning creates nothing in T3, so there is nothing else to check before doing it.
*/

export type WorkPlannedContext = { readonly thread: "missing" } | { readonly thread: "present" };

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

// Picks the base fields so states that must not carry `t3` do not inherit it at runtime.
const baseOf = ({
  sourceUri,
  snapshot,
  attachments,
  target,
  createdAt,
  updatedAt,
}: ExchangeBase): ExchangeBase => ({
  sourceUri,
  snapshot,
  attachments,
  target,
  createdAt,
  updatedAt,
});

export const toWorkPlanned = (
  state: RequestAccepted,
  coordinates: WorkCoordinates,
  now: number,
): WorkPlanned => ({
  ...state,
  updatedAt: now,
  tag: "work-planned",
  t3: coordinates,
});

export const toThreadCreated = (state: WorkPlanned, now: number): ThreadCreated => ({
  ...state,
  updatedAt: now,
  tag: "thread-created",
});

export const toReplyPending = (
  state: RequestAccepted | WorkPlanned | ThreadCreated,
  reply: Reply,
  now: number,
): ReplyPending => ({
  ...baseOf(state),
  updatedAt: now,
  tag: "reply-pending",
  reply,
});

/** What T3 said when it rejected a step for good; `method` names the T3 call that answered. */
export type Rejection = {
  readonly reason: string;
  readonly method: string;
};

/**
 * T3 rejected the work for good while the exchange was in `state`. Each state has exactly one action, so the state itself records which step was rejected and what T3 data existed.
 */
export const toRejected = (
  state: RequestAccepted | WorkPlanned | ThreadCreated,
  rejection: Rejection,
  now: number,
): ReplyPending =>
  toReplyPending(
    state,
    {
      type: "failure",
      text: rejection.reason,
      cause: {
        type: "rejected",
        method: rejection.method,
        state:
          state.tag === "request-accepted" ? { tag: state.tag } : { tag: state.tag, t3: state.t3 },
      },
    },
    now,
  );

/** The state outlived its deadline; the reply tells the user we gave up and the cause records where. */
export const toExpired = (
  state: RequestAccepted | WorkPlanned | ThreadCreated,
  now: number,
): ReplyPending =>
  toReplyPending(
    state,
    {
      type: "failure",
      text: "T3 did not answer in time.",
      cause: {
        type: "expired",
        state:
          state.tag === "request-accepted" ? { tag: state.tag } : { tag: state.tag, t3: state.t3 },
      },
    },
    now,
  );

export const toReplyPosted = (
  state: ReplyPending,
  replySourceUri: string,
  now: number,
): ReplyPosted => ({
  ...state,
  updatedAt: now,
  tag: "reply-posted",
  replySourceUri,
});

export const toUndeliverable = (
  state: ReplyPending,
  cause: UndeliverableCause,
  now: number,
): Undeliverable => ({
  ...state,
  updatedAt: now,
  tag: "undeliverable",
  cause,
});

export type RequestAcceptedDecision = { readonly type: "plan" } | { readonly type: "expire" };

export type WorkPlannedDecision =
  | { readonly type: "provision-thread" }
  | { readonly type: "record-thread-created" }
  | { readonly type: "expire" };

export type ThreadCreatedDecision =
  | { readonly type: "start-turn" }
  | { readonly type: "wait" }
  | {
      readonly type: "record-reply-pending";
      readonly reply: Reply;
    }
  | { readonly type: "expire" };

export type ReplyPendingDecision =
  | { readonly type: "post-reply" }
  | {
      readonly type: "record-reply-posted";
      readonly replySourceUri: string;
    }
  | { readonly type: "expire" };

export const fromRequestAccepted = (state: RequestAccepted, now: number): RequestAcceptedDecision =>
  isExpired(state, now) ? { type: "expire" } : { type: "plan" };

export const fromWorkPlanned = (
  state: WorkPlanned,
  context: WorkPlannedContext,
  now: number,
): WorkPlannedDecision => {
  switch (context.thread) {
    case "missing":
      return isExpired(state, now) ? { type: "expire" } : { type: "provision-thread" };

    case "present":
      return { type: "record-thread-created" };
  }
};

export const fromThreadCreated = (
  state: ThreadCreated,
  context: ThreadCreatedContext,
  now: number,
): ThreadCreatedDecision => {
  switch (context.turn) {
    case "missing":
      return isExpired(state, now) ? { type: "expire" } : { type: "start-turn" };

    case "active":
      return isExpired(state, now) ? { type: "expire" } : { type: "wait" };

    case "completed":
      return {
        type: "record-reply-pending",
        reply: context.reply,
      };
  }
};

export const fromReplyPending = (
  state: ReplyPending,
  context: ReplyPendingContext,
  now: number,
): ReplyPendingDecision => {
  switch (context.platformReply) {
    case "missing":
      return isExpired(state, now) ? { type: "expire" } : { type: "post-reply" };

    case "posted":
      return {
        type: "record-reply-posted",
        replySourceUri: context.replySourceUri,
      };
  }
};
