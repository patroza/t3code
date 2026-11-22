import { describe, expect, it } from "vite-plus/test";
import { sourceConversationKey } from "./TeamsNativeApp.ts";

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
