import { describe, expect, it } from "vite-plus/test";

import { messageDeepLinkHash, parseMessageIdFromHash, parseOmegentDeepLink } from "./deepLinks.ts";
import {
  clearPendingDeepLink,
  hasAwaitingThreadDeepLink,
  markDeepLinkNavigationIssued,
  peekPendingDeepLink,
  setPendingDeepLink,
  takePendingDeepLinkMessage,
} from "./deepLinkStore.ts";

describe("parseOmegentDeepLink", () => {
  it("parses thread query and message hash", () => {
    const url = new URL("https://t3vm.tail86038f.ts.net/?thread=tid-1#message-msg-1");
    expect(parseOmegentDeepLink(url)).toEqual({
      threadId: "tid-1",
      messageId: "msg-1",
    });
  });

  it("handles thread-only and message-only forms", () => {
    expect(parseOmegentDeepLink(new URL("https://t3vm/?thread=tid-2"))).toEqual({
      threadId: "tid-2",
      messageId: null,
    });
    expect(parseOmegentDeepLink(new URL("https://t3vm/#message-msg-9"))).toEqual({
      threadId: null,
      messageId: "msg-9",
    });
  });

  it("requires the message- prefix on the hash", () => {
    expect(parseMessageIdFromHash("#msg-1")).toBeNull();
    expect(parseMessageIdFromHash("#message-msg-1")).toBe("msg-1");
    expect(messageDeepLinkHash("msg-1")).toBe("#message-msg-1");
  });
});

describe("deepLinkStore", () => {
  it("hands off message scroll once per thread", () => {
    clearPendingDeepLink();
    setPendingDeepLink({ threadId: "tid-1", messageId: "msg-1" });
    expect(peekPendingDeepLink()).toEqual({
      threadId: "tid-1",
      messageId: "msg-1",
      awaitingNavigation: true,
    });
    expect(takePendingDeepLinkMessage("tid-2")).toBeNull();
    expect(takePendingDeepLinkMessage("tid-1")).toBe("msg-1");
    expect(takePendingDeepLinkMessage("tid-1")).toBeNull();
    clearPendingDeepLink();
  });

  it("tracks awaiting navigation for index deferral", () => {
    clearPendingDeepLink();
    setPendingDeepLink({ threadId: "tid-1", messageId: null });
    expect(peekPendingDeepLink()?.awaitingNavigation).toBe(true);
    expect(hasAwaitingThreadDeepLink()).toBe(true);
    markDeepLinkNavigationIssued("tid-1");
    expect(hasAwaitingThreadDeepLink()).toBe(false);
    expect(peekPendingDeepLink()).toEqual({
      threadId: "tid-1",
      messageId: null,
      awaitingNavigation: false,
    });
    clearPendingDeepLink();
  });
});
