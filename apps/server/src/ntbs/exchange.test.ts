import { describe, expect, it } from "@effect/vitest";
import {
  fromReplyPending,
  fromThreadCreated,
  fromWorkPlanned,
  getThreadId,
  isUpdateOf,
  makeRequestAccepted,
  toRejected,
  toReplyPending,
  toReplyPosted,
  toThreadCreated,
  toUndeliverable,
  toWorkPlanned,
  type Exchange,
  type ExchangeBase,
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

const exchangeBase = { ...request, target } satisfies ExchangeBase;

const rejection = { reason: "T3 said no", method: "someT3Call" };

const accepted = makeRequestAccepted(request, target);
const planned = toWorkPlanned(accepted, coordinates);
const threadCreated = toThreadCreated(planned);
const answer = { type: "answer", text: "The turn's final answer", ...turn } as const;

describe("RequestAccepted", () => {
  it("makeRequestAccepted tags the request and target, nothing from T3", () => {
    expect(accepted).toEqual({ ...exchangeBase, tag: "request-accepted" });
  });

  it("toWorkPlanned adds the coordinates", () => {
    expect(planned).toEqual({ ...exchangeBase, tag: "work-planned", t3: coordinates });
  });

  it("a planning rejection becomes a failure reply with no T3 context", () => {
    expect(toRejected(accepted, rejection)).toEqual({
      ...exchangeBase,
      tag: "reply-pending",
      reply: {
        type: "failure",
        text: rejection.reason,
        cause: { type: "rejected", method: rejection.method, state: { tag: "request-accepted" } },
      },
    });
  });
});

describe("WorkPlanned", () => {
  // if thread is missing we provision the thread
  // if its present we record it's been created
  it.each([
    [{ thread: "missing" }, { type: "provision-thread" }],
    [{ thread: "present" }, { type: "record-thread-created" }],
  ] as const)("decides %j -> %j", (context, expected) => {
    expect(fromWorkPlanned(planned, context)).toEqual(expected);
  });

  it("toThreadCreated retags and carries the coordinates forward", () => {
    expect(threadCreated).toEqual({ ...exchangeBase, tag: "thread-created", t3: coordinates });
  });

  it("a provisioning rejection keeps the planned coordinates inside the reply only", () => {
    expect(toRejected(planned, rejection)).toEqual({
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
});

describe("ThreadCreated", () => {
  // missing turn -> start it; active turn -> wait; completed turn -> record its reply
  it.each([
    [{ turn: "missing" }, { type: "start-turn" }],
    [{ turn: "active" }, { type: "wait" }],
    [
      { turn: "completed", reply: answer },
      { type: "record-reply-pending", reply: answer },
    ],
  ] as const)("decides %j -> %j", (context, expected) => {
    expect(fromThreadCreated(threadCreated, context)).toEqual(expected);
  });

  it("completed turn's reply lands in ReplyPending verbatim and drops the coordinates", () => {
    expect(toReplyPending(threadCreated, answer)).toEqual({
      ...exchangeBase,
      tag: "reply-pending",
      reply: answer,
    });
  });

  it("a turn-start rejection keeps the coordinates inside the reply only", () => {
    expect(toRejected(threadCreated, rejection).reply).toEqual({
      type: "failure",
      text: rejection.reason,
      cause: {
        type: "rejected",
        method: rejection.method,
        state: { tag: "thread-created", t3: coordinates },
      },
    });
  });
});

describe("ReplyPending", () => {
  const replyPending = toReplyPending(threadCreated, answer);

  // missing platform reply -> post it; posted -> record its message id
  it.each([
    [{ platformReply: "missing" }, { type: "post-reply" }],
    [
      { platformReply: "posted", replySourceUri: "test://exchange/reply" },
      { type: "record-reply-posted", replySourceUri: "test://exchange/reply" },
    ],
  ] as const)("decides %j -> %j", (context, expected) => {
    expect(fromReplyPending(replyPending, context)).toEqual(expected);
  });

  it("accepted delivery lands in ReplyPosted with the platform message id", () => {
    expect(toReplyPosted(replyPending, "test://exchange/reply")).toEqual({
      ...exchangeBase,
      tag: "reply-posted",
      reply: answer,
      replySourceUri: "test://exchange/reply",
    });
  });

  it("definitive rejection lands in Undeliverable with the reply and cause", () => {
    const cause = { message: "original message was deleted" } as const;
    expect(toUndeliverable(replyPending, cause)).toEqual({
      ...exchangeBase,
      tag: "undeliverable",
      reply: answer,
      cause,
    });
  });
});

describe("isUpdateOf", () => {
  const replyPending = toReplyPending(threadCreated, answer);
  const posted = toReplyPosted(replyPending, "test://exchange/reply");
  const undeliverable = toUndeliverable(replyPending, { message: "gone" });

  it.each<[string, Exchange, Exchange]>([
    ["the same state rewritten", accepted, accepted],
    ["accepted -> planned", planned, accepted],
    ["accepted -> reply-pending", toRejected(accepted, rejection), accepted],
    ["planned -> thread-created", threadCreated, planned],
    ["planned -> reply-pending", toRejected(planned, rejection), planned],
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
    ["the answer's thread", toReplyPending(threadCreated, answer), turn.threadId],
    ["a settled failure's thread", toReplyPending(threadCreated, settled), turn.threadId],
    ["nothing for a planning rejection", toRejected(accepted, rejection), null],
    [
      "the planned thread for a later rejection",
      toRejected(planned, rejection),
      coordinates.threadId,
    ],
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
  toThreadCreated(posted);
  // @ts-expect-error a bare acceptance cannot record a posted reply
  toReplyPosted(accepted, "reply://msg");
  // @ts-expect-error Undeliverable is entered only from ReplyPending
  toUndeliverable(accepted, { message: "cause" });
  // @ts-expect-error planning happens once, before the thread exists
  toWorkPlanned(created, coordinates);
};
