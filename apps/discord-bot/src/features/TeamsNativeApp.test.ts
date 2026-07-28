import { describe, expect, it } from "vite-plus/test";

import { sourceConversationKey, splitTeamsMessage } from "./TeamsNativeApp.ts";

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
