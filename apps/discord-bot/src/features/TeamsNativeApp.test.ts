import { MessageId, TurnId } from "@t3tools/contracts";
import type { IntegrationThreadView } from "@t3tools/shared/integrationThreadView";
import { describe, expect, it } from "vite-plus/test";

import { sourceConversationKey, splitTeamsMessage, teamsRunDelivery } from "./TeamsNativeApp.ts";

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
    }) as IntegrationThreadView;

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
