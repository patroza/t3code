import { it as effectIt } from "@effect/vitest";
import { MessageId, ThreadId, TurnId } from "@t3tools/contracts";
import type { IntegrationThreadView } from "@t3tools/shared/integrationThreadView";
import * as Effect from "effect/Effect";
import { T3Session } from "../t3/T3Session.ts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  sourceConversationKey,
  splitTeamsMessage,
  teamsRunDelivery,
  teamsTurnSettled,
  teamsVisibleText,
  waitForFinalAnswer,
} from "./TeamsNativeApp.ts";

describe("sourceConversationKey", () => {
  it("keeps native Teams conversations distinct by tenant and location", () => {
    expect(
      sourceConversationKey({
        tenantId: "tenant",
        teamId: "team",
        channelId: "channel",
        conversationId: "conversation;messageid=root",
      }),
    ).toBe("native/tenant/team/channel/conversation;messageid=root");
  });

  it("supports personal chats", () => {
    expect(
      sourceConversationKey({
        tenantId: "tenant",
        teamId: undefined,
        channelId: undefined,
        conversationId: "personal-chat",
      }),
    ).toBe("native/tenant/chat/chat/personal-chat");
  });
});

describe("teamsTurnSettled", () => {
  it("keeps an idle session in progress while the turn is still running", () => {
    expect(
      teamsTurnSettled({
        session: { status: "idle" },
        latestTurn: { state: "running" },
      }),
    ).toBe(false);
  });

  it("waits for a turn to appear", () => {
    expect(teamsTurnSettled({ session: { status: "ready" }, latestTurn: null })).toBe(false);
    expect(teamsTurnSettled({ session: { status: "starting" }, latestTurn: null })).toBe(false);
  });

  it("settles when the turn leaves running", () => {
    expect(
      teamsTurnSettled({
        session: { status: "idle" },
        latestTurn: { state: "completed" },
      }),
    ).toBe(true);
  });
});

describe("teamsVisibleText", () => {
  it("acks with a working indicator before any assistant text", () => {
    expect(
      teamsVisibleText({
        preface: "Started T3 for **omegent**.\n[Open in T3 Code](https://omega.example/?thread=1)",
        body: "",
        inProgress: true,
      }),
    ).toBe(
      "Started T3 for **omegent**.\n[Open in T3 Code](https://omega.example/?thread=1)\n\n_Working.._",
    );
  });

  it("keeps the interim reply marked as still working", () => {
    const text = teamsVisibleText({
      preface: "Started T3 for **omegent**.",
      body: "I'll check the current time.",
      inProgress: true,
      dotCount: 3,
      toolCallCount: 1,
    });
    expect(text).toContain("I'll check the current time.");
    expect(text).toContain("_Working... · 1 tool call_");
  });

  it("replaces the working indicator with the final answer", () => {
    expect(
      teamsVisibleText({
        preface: "Started T3 for **omegent**.",
        body: "The time is 15:00 UTC.",
        inProgress: false,
      }),
    ).toBe("Started T3 for **omegent**.\n\nThe time is 15:00 UTC.");
  });
});

describe("splitTeamsMessage", () => {
  it("keeps short answers intact", () => {
    expect(splitTeamsMessage("done")).toEqual(["done"]);
  });

  it("splits large answers below the Teams delivery ceiling without losing text", () => {
    const input = `${"a".repeat(15_000)}\n\n${"b".repeat(15_000)}`;
    const chunks = splitTeamsMessage(input);
    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= 25_000)).toBe(true);
    expect(chunks.join("\n\n")).toBe(input);
  });
});

describe("Teams run delivery", () => {
  const request = MessageId.make("request");
  const followup = MessageId.make("followup");
  const snapshot = (status: string, texts: string[]): IntegrationThreadView =>
    ({
      updatedAt: "2026-10-11T13:00:49Z",
      activities: [],
      runStatuses: [{ id: "run-1", status, userMessageId: request }],
      session: { status: "ready", activeTurnId: null },
      latestTurn: {
        turnId: TurnId.make("run-1"),
        state: status === "completed" ? "completed" : "running",
      },
      messages: texts.map((text, i) => ({
        id: MessageId.make(`answer-${i}`),
        role: "assistant",
        turnId: TurnId.make("run-1"),
        text,
        streaming: false,
      })),
    }) as unknown as IntegrationThreadView;

  it("waits through provider readiness between commentary and a final answer", () => {
    expect(
      teamsRunDelivery(snapshot("running", ["I’ll check the current time."]), request),
    ).toEqual({ kind: "pending" });
    expect(
      teamsRunDelivery(
        snapshot("completed", ["I’ll check the current time.", "It’s 13:00 UTC."]),
        request,
      ),
    ).toEqual({ kind: "completed", answer: "It’s 13:00 UTC." });
  });

  effectIt.live("polls past interim commentary and sends only the completed answer", () =>
    Effect.gen(function* () {
      let polls = 0;
      const send = vi.fn(async (_text: string) => {});
      yield* waitForFinalAnswer({
        t3ThreadId: ThreadId.make("thread"),
        messageId: request,
        baseline: "",
        baselineTurnId: null,
        send,
      }).pipe(
        Effect.provideService(T3Session, {
          fetchThreadDetail: () =>
            Effect.sync(() => {
              polls++;
              expect(send).not.toHaveBeenCalled();
              return {
                thread:
                  polls === 1
                    ? snapshot("running", ["I’ll check the current time."])
                    : snapshot("completed", ["I’ll check the current time.", "It’s 13:00 UTC."]),
              };
            }),
        } as never),
      );
      expect(polls).toBe(2);
      expect(send).toHaveBeenCalledExactlyOnceWith("It’s 13:00 UTC.");
    }),
  );

  effectIt.live("edits one ack from the working indicator to the final answer", () =>
    Effect.gen(function* () {
      let polls = 0;
      const send = vi.fn(async (_text: string) => {});
      const replaceProgress = vi.fn(async (_text: string) => {});
      const preface = "Started T3 for **omegent**.";
      yield* waitForFinalAnswer({
        t3ThreadId: ThreadId.make("thread"),
        messageId: request,
        baseline: "",
        baselineTurnId: null,
        preface,
        send,
        replaceProgress,
      }).pipe(
        Effect.provideService(T3Session, {
          fetchThreadDetail: () =>
            Effect.sync(() => {
              polls++;
              expect(send).not.toHaveBeenCalled();
              return {
                thread:
                  polls === 1
                    ? snapshot("running", ["I’ll check the current time."])
                    : snapshot("completed", ["I’ll check the current time.", "It’s 13:00 UTC."]),
              };
            }),
        } as never),
      );
      expect(polls).toBe(2);
      expect(send).not.toHaveBeenCalled();
      expect(replaceProgress).toHaveBeenNthCalledWith(
        1,
        teamsVisibleText({
          preface,
          body: "I’ll check the current time.",
          inProgress: true,
        }),
      );
      expect(replaceProgress).toHaveBeenLastCalledWith(
        "Started T3 for **omegent**.\n\nIt’s 13:00 UTC.",
      );
    }),
  );

  it("cannot deliver an old answer to a queued follow-up", () => {
    const thread = snapshot("completed", ["It’s 13:00 UTC."]);
    expect(teamsRunDelivery(thread, followup)).toEqual({ kind: "pending" });
    expect(
      teamsRunDelivery(
        {
          ...thread,
          runStatuses: [
            ...thread.runStatuses!,
            { id: "run-2", status: "queued", userMessageId: followup },
          ],
        },
        followup,
      ),
    ).toEqual({ kind: "pending" });
  });

  it("keeps overlapping observers correlated when the latest run changes", () => {
    const thread = snapshot("completed", ["First final answer"]);
    const next = {
      ...thread,
      latestTurn: {
        ...thread.latestTurn!,
        turnId: TurnId.make("run-2"),
        state: "completed" as const,
      },
      runStatuses: [
        ...thread.runStatuses!,
        { id: "run-2", status: "completed", userMessageId: followup },
      ],
      messages: [
        ...thread.messages,
        {
          ...thread.messages[0]!,
          id: MessageId.make("next-answer"),
          turnId: TurnId.make("run-2"),
          text: "Second final answer",
        },
      ],
    };
    expect(teamsRunDelivery(next, request)).toEqual({
      kind: "completed",
      answer: "First final answer",
    });
    expect(teamsRunDelivery(next, followup)).toEqual({
      kind: "completed",
      answer: "Second final answer",
    });
  });

  it.each(["failed", "interrupted", "cancelled", "rolled_back"])(
    "reports %s instead of presenting commentary as a final answer",
    (status) => {
      expect(teamsRunDelivery(snapshot(status, ["I’ll check."]), request)).toMatchObject({
        kind: "failed",
      });
    },
  );

  it("distinguishes completed empty output from a pending run", () => {
    expect(teamsRunDelivery(snapshot("completed", []), request)).toEqual({
      kind: "completed",
      answer: "",
    });
  });
});
