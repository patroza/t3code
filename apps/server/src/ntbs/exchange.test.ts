import { describe, expect, it } from "@effect/vitest";
import {
  fromReplyPending,
  fromRequestClaimed,
  fromThreadCreated,
  makeRequestClaimed,
  toReplyPending,
  toReplyPosted,
  toThreadCreated,
  toUndeliverable,
  type ExchangeBase,
  type ReplyPosted,
  type RequestClaimed,
} from "./exchange.ts";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";

const exchangeStateBase = {
  sourceUri: "test://exchange/test",
  snapshot: "You need to imagine some text here",
  attachments: [],
  t3: {
    projectId: ProjectId.make("projectId"),
    baseRef: "baseRef",
    threadId: ThreadId.make("threadId"),
    userMessageId: MessageId.make("messageId"),
    branchName: "branchName",
  },
} satisfies ExchangeBase;

describe("RequestClaimed", () => {
  const claimed = makeRequestClaimed(exchangeStateBase);

  it("makeRequestClaimed tags the base unchanged", () => {
    expect(claimed).toEqual({ ...exchangeStateBase, tag: "request-claimed" });
  });

  // if thread is missing we provision the thread
  // if its present we record it's been created
  it.each([
    [{ thread: "missing" }, { type: "provision-thread" }],
    [{ thread: "present" }, { type: "record-thread-created" }],
  ] as const)("decides %j -> %j", (context, expected) => {
    expect(fromRequestClaimed(claimed, context)).toEqual(expected);
  });

  it("toThreadCreated retags and carries every claim field forward", () => {
    expect(toThreadCreated(claimed)).toEqual({ ...exchangeStateBase, tag: "thread-created" });
  });

  it("provisioning failure jumps ahead with the reply stored verbatim", () => {
    const reply = { type: "failure", text: "provisioning rejected" } as const;
    expect(toReplyPending(claimed, reply)).toEqual({
      ...exchangeStateBase,
      tag: "reply-pending",
      reply,
    });
  });
});

describe("ThreadCreated", () => {
  const threadCreated = toThreadCreated(makeRequestClaimed(exchangeStateBase));
  const answer = { type: "answer", text: "The turn's final answer" } as const;

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

  it("completed turn's reply lands in ReplyPending verbatim", () => {
    expect(toReplyPending(threadCreated, answer)).toEqual({
      ...exchangeStateBase,
      tag: "reply-pending",
      reply: answer,
    });
  });
});

describe("ReplyPending", () => {
  const reply = { type: "answer", text: "The turn's final answer" } as const;
  const replyPending = toReplyPending(
    toThreadCreated(makeRequestClaimed(exchangeStateBase)),
    reply,
  );

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
      ...exchangeStateBase,
      tag: "reply-posted",
      reply,
      replySourceUri: "test://exchange/reply",
    });
  });

  it("definitive rejection lands in Undeliverable with the reply and cause", () => {
    const cause = { message: "original message was deleted" } as const;
    expect(toUndeliverable(replyPending, cause)).toEqual({
      ...exchangeStateBase,
      tag: "undeliverable",
      reply,
      cause,
    });
  });
});

/*
Type-level: forward-only is structural. Never executed — typecheck enforces
these. If an `@ts-expect-error` stops erroring, a constructor's input type
widened and the forward-only guarantee broke.
*/
const _forwardOnly = (posted: ReplyPosted, claimed: RequestClaimed) => {
  // @ts-expect-error terminal states cannot re-enter thread creation
  toThreadCreated(posted);
  // @ts-expect-error a bare claim cannot record a posted reply
  toReplyPosted(claimed, "reply://msg");
  // @ts-expect-error Undeliverable is entered only from ReplyPending
  toUndeliverable(claimed, { message: "cause" });
};
