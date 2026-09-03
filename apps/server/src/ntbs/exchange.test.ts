import { describe, expect, it } from "@effect/vitest";
import { Duration } from "effect";
import {
  fromReplyPending,
  fromRequestAccepted,
  fromThreadCreated,
  fromWorkPlanned,
  getThreadId,
  isExpired,
  isUpdateOf,
  makeRequestAccepted,
  toExpired,
  toRejected,
  toReplyPending,
  toReplyPosted,
  toThreadCreated,
  toUndeliverable,
  toWorkPlanned,
  type Exchange,
  type ExchangeBase,
  type NonTerminalExchange,
  type ReplyPosted,
  type Request,
  type RequestAccepted,
  type T3Target,
  type ThreadCreated,
  type TurnCoordinates,
  type WorkCoordinates,
} from "./exchange.ts";
import { MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";

const request = {
  sourceUri: "test://exchange/test",
  snapshot: "You need to imagine some text here",
  attachments: [],
} satisfies Request;

const target = {
  projectId: ProjectId.make("projectId"),
  startBranchName: "startBranchName",
} satisfies T3Target;

const coordinates = {
  projectId: target.projectId,
  startBranchName: target.startBranchName,
  startCommitSha: "startCommitSha",
  threadId: ThreadId.make("threadId"),
  userMessageId: MessageId.make("messageId"),
  worktreeBranchName: "worktreeBranchName",
} satisfies WorkCoordinates;

const turn = {
  threadId: coordinates.threadId,
  userMessageId: coordinates.userMessageId,
  turnId: TurnId.make("turnId"),
} satisfies TurnCoordinates;

const now = 1_700_000_000_000;
// Past every state's deadline.
const later = now + Duration.toMillis(Duration.hours(2));

const exchangeBase = { ...request, target, createdAt: now, updatedAt: now } satisfies ExchangeBase;

const rejection = { reason: "T3 said no", method: "someT3Call" };

const accepted = makeRequestAccepted(request, target, now);
const planned = toWorkPlanned(accepted, coordinates, now);
const threadCreated = toThreadCreated(planned, now);
const answer = { type: "answer", text: "The turn's final answer", ...turn } as const;

describe("RequestAccepted", () => {
  it("makeRequestAccepted tags the request and target, nothing from T3", () => {
    expect(accepted).toEqual({ ...exchangeBase, tag: "request-accepted" });
  });

  it("toWorkPlanned adds the coordinates", () => {
    expect(planned).toEqual({ ...exchangeBase, tag: "work-planned", t3: coordinates });
  });

  it("a transition stamps updatedAt and keeps createdAt", () => {
    expect(toWorkPlanned(accepted, coordinates, later)).toEqual({
      ...exchangeBase,
      updatedAt: later,
      tag: "work-planned",
      t3: coordinates,
    });
  });

  it.each([
    [now, { type: "plan" }],
    [later, { type: "expire" }],
  ] as const)("decides at %d -> %j", (at, expected) => {
    expect(fromRequestAccepted(accepted, at)).toEqual(expected);
  });

  it("a planning rejection becomes a failure reply with no T3 context", () => {
    expect(toRejected(accepted, rejection, now)).toEqual({
      ...exchangeBase,
      tag: "reply-pending",
      reply: {
        type: "failure",
        text: rejection.reason,
        cause: { type: "rejected", method: rejection.method, state: { tag: "request-accepted" } },
      },
    });
  });

  it("expiry becomes a failure reply with no T3 context", () => {
    expect(toExpired(accepted, later)).toEqual({
      ...exchangeBase,
      updatedAt: later,
      tag: "reply-pending",
      reply: {
        type: "failure",
        text: "T3 did not answer in time.",
        cause: { type: "expired", state: { tag: "request-accepted" } },
      },
    });
  });
});

describe("WorkPlanned", () => {
  // missing thread -> provision it, unless expired; present thread -> record it, even when expired
  it.each([
    [{ thread: "missing" }, now, { type: "provision-thread" }],
    [{ thread: "present" }, now, { type: "record-thread-created" }],
    [{ thread: "missing" }, later, { type: "expire" }],
    [{ thread: "present" }, later, { type: "record-thread-created" }],
  ] as const)("decides %j at %d -> %j", (context, at, expected) => {
    expect(fromWorkPlanned(planned, context, at)).toEqual(expected);
  });

  it("toThreadCreated retags and carries the coordinates forward", () => {
    expect(threadCreated).toEqual({ ...exchangeBase, tag: "thread-created", t3: coordinates });
  });

  it("a provisioning rejection keeps the planned coordinates inside the reply only", () => {
    expect(toRejected(planned, rejection, now)).toEqual({
      ...exchangeBase,
      tag: "reply-pending",
      reply: {
        type: "failure",
        text: rejection.reason,
        cause: {
          type: "rejected",
          method: rejection.method,
          state: { tag: "work-planned", t3: coordinates },
        },
      },
    });
  });

  it("expiry keeps the planned coordinates inside the reply only", () => {
    expect(toExpired(planned, later).reply).toEqual({
      type: "failure",
      text: "T3 did not answer in time.",
      cause: { type: "expired", state: { tag: "work-planned", t3: coordinates } },
    });
  });
});

describe("ThreadCreated", () => {
  // missing turn -> start it; active turn -> wait; both expire; completed turn -> record its reply, even when expired
  it.each([
    [{ turn: "missing" }, now, { type: "start-turn" }],
    [{ turn: "active" }, now, { type: "wait" }],
    [{ turn: "completed", reply: answer }, now, { type: "record-reply-pending", reply: answer }],
    [{ turn: "missing" }, later, { type: "expire" }],
    [{ turn: "active" }, later, { type: "expire" }],
    [{ turn: "completed", reply: answer }, later, { type: "record-reply-pending", reply: answer }],
  ] as const)("decides %j at %d -> %j", (context, at, expected) => {
    expect(fromThreadCreated(threadCreated, context, at)).toEqual(expected);
  });

  it("completed turn's reply lands in ReplyPending verbatim and drops the coordinates", () => {
    expect(toReplyPending(threadCreated, answer, now)).toEqual({
      ...exchangeBase,
      tag: "reply-pending",
      reply: answer,
    });
  });

  it("a turn-start rejection keeps the coordinates inside the reply only", () => {
    expect(toRejected(threadCreated, rejection, now).reply).toEqual({
      type: "failure",
      text: rejection.reason,
      cause: {
        type: "rejected",
        method: rejection.method,
        state: { tag: "thread-created", t3: coordinates },
      },
    });
  });

  it("expiry keeps the coordinates inside the reply only", () => {
    expect(toExpired(threadCreated, later).reply).toEqual({
      type: "failure",
      text: "T3 did not answer in time.",
      cause: { type: "expired", state: { tag: "thread-created", t3: coordinates } },
    });
  });
});

describe("ReplyPending", () => {
  const replyPending = toReplyPending(threadCreated, answer, now);

  // missing platform reply -> post it, unless expired; posted -> record its message id, even when expired
  it.each([
    [{ platformReply: "missing" }, now, { type: "post-reply" }],
    [
      { platformReply: "posted", replySourceUri: "test://exchange/reply" },
      now,
      { type: "record-reply-posted", replySourceUri: "test://exchange/reply" },
    ],
    [{ platformReply: "missing" }, later, { type: "expire" }],
    [
      { platformReply: "posted", replySourceUri: "test://exchange/reply" },
      later,
      { type: "record-reply-posted", replySourceUri: "test://exchange/reply" },
    ],
  ] as const)("decides %j at %d -> %j", (context, at, expected) => {
    expect(fromReplyPending(replyPending, context, at)).toEqual(expected);
  });

  it("accepted delivery lands in ReplyPosted with the platform message id", () => {
    expect(toReplyPosted(replyPending, "test://exchange/reply", now)).toEqual({
      ...exchangeBase,
      tag: "reply-posted",
      reply: answer,
      replySourceUri: "test://exchange/reply",
    });
  });

  it("definitive rejection lands in Undeliverable with the reply and cause", () => {
    const cause = { message: "original message was deleted" } as const;
    expect(toUndeliverable(replyPending, cause, now)).toEqual({
      ...exchangeBase,
      tag: "undeliverable",
      reply: answer,
      cause,
    });
  });
});

describe("isExpired", () => {
  const replyPending = toReplyPending(threadCreated, answer, now);

  it.each<[string, NonTerminalExchange]>([
    ["request-accepted", accepted],
    ["work-planned", planned],
    ["thread-created", threadCreated],
    ["reply-pending", replyPending],
  ])("%s is fresh at its own updatedAt and expired two hours later", (_, state) => {
    expect(isExpired(state, now)).toBe(false);
    expect(isExpired(state, later)).toBe(true);
  });
});

describe("isUpdateOf", () => {
  const replyPending = toReplyPending(threadCreated, answer, now);
  const posted = toReplyPosted(replyPending, "test://exchange/reply", now);
  const undeliverable = toUndeliverable(replyPending, { message: "gone" }, now);

  it.each<[string, Exchange, Exchange]>([
    ["the same state rewritten", accepted, accepted],
    ["accepted -> planned", planned, accepted],
    ["accepted -> reply-pending", toRejected(accepted, rejection, now), accepted],
    ["planned -> thread-created", threadCreated, planned],
    ["planned -> reply-pending", toRejected(planned, rejection, now), planned],
    ["thread-created -> reply-pending", replyPending, threadCreated],
    ["reply-pending -> reply-posted", posted, replyPending],
    ["reply-pending -> undeliverable", undeliverable, replyPending],
  ])("accepts %s", (_, next, previous) => {
    expect(isUpdateOf(next, previous)).toBe(true);
  });

  it.each<[string, Exchange, Exchange]>([
    ["going back", planned, threadCreated],
    ["skipping ahead", threadCreated, accepted],
    ["moving a posted reply", replyPending, posted],
    ["moving an undeliverable reply", posted, undeliverable],
    ["another exchange", { ...planned, sourceUri: "test://exchange/other" }, accepted],
  ])("refuses %s", (_, next, previous) => {
    expect(isUpdateOf(next, previous)).toBe(false);
  });
});

describe("getThreadId", () => {
  const settled = {
    type: "failure",
    text: "T3 failed",
    cause: { type: "settled", ...turn },
  } as const;

  it.each<[string, Exchange, ThreadId | null]>([
    ["nothing before planning", accepted, null],
    ["the coordinates while planned", planned, coordinates.threadId],
    ["the coordinates while the thread exists", threadCreated, coordinates.threadId],
    ["the answer's thread", toReplyPending(threadCreated, answer, now), turn.threadId],
    ["a settled failure's thread", toReplyPending(threadCreated, settled, now), turn.threadId],
    ["nothing for a planning rejection", toRejected(accepted, rejection, now), null],
    [
      "the planned thread for a later rejection",
      toRejected(planned, rejection, now),
      coordinates.threadId,
    ],
    ["nothing for a planning expiry", toExpired(accepted, later), null],
    ["the planned thread for a later expiry", toExpired(planned, later), coordinates.threadId],
  ])("finds %s", (_, exchange, expected) => {
    expect(getThreadId(exchange)).toBe(expected);
  });
});

/*
Type-level: forward-only is structural. Never executed — typecheck enforces
these. If an `@ts-expect-error` stops erroring, a constructor's input type
widened and the forward-only guarantee broke.
*/
const _forwardOnly = (posted: ReplyPosted, accepted: RequestAccepted, created: ThreadCreated) => {
  // @ts-expect-error terminal states cannot re-enter thread creation
  toThreadCreated(posted, now);
  // @ts-expect-error a bare acceptance cannot record a posted reply
  toReplyPosted(accepted, "reply://msg", now);
  // @ts-expect-error Undeliverable is entered only from ReplyPending
  toUndeliverable(accepted, { message: "cause" }, now);
  // @ts-expect-error planning happens once, before the thread exists
  toWorkPlanned(created, coordinates, now);
};
