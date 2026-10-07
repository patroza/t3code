import { EnvironmentId, MessageId, ThreadId, type AssistantCitation } from "@t3tools/contracts";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  assistantCitationFromLocation,
  assistantCitationNavigation,
} from "./assistantCitationNavigation";

const citation: AssistantCitation = {
  version: 1,
  environmentId: EnvironmentId.make("environment-one"),
  threadId: ThreadId.make("thread-one"),
  messageId: MessageId.make("assistant-one"),
  text: "first line\n\tsecond line (with a #hash & spaces) 🚀",
  start: 12,
  end: 59,
  prefix: "Before:\n",
  suffix: "\nAfter.",
};

beforeEach(() => {
  // Router 1.171 writes `history.scrollRestoration` while setting up a client
  // router. This file runs in the node unit project, which has no DOM.
  vi.stubGlobal("history", { scrollRestoration: "auto" });
  vi.stubGlobal("document", {
    addEventListener() {},
    removeEventListener() {},
  });
  vi.stubGlobal("addEventListener", () => {});
  vi.stubGlobal("self", globalThis);
});

afterEach(() => {
  delete (globalThis as { __TSR_ROUTER__?: unknown }).__TSR_ROUTER__;
  vi.unstubAllGlobals();
});

function createCitationRouter(initialEntry = "/environment-one/thread-one") {
  const root = createRootRoute();
  const thread = createRoute({ getParentRoute: () => root, path: "/$environmentId/$threadId" });
  return createRouter({
    routeTree: root.addChildren([thread]),
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    isServer: false,
    origin: "http://localhost",
  });
}

describe("assistant citation navigation", () => {
  it("preserves encoded quote whitespace through router navigation and reload", async () => {
    const router = createCitationRouter();
    await router.load();
    await router.navigate(assistantCitationNavigation(citation));

    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
    let href = router.history.location.href;
    for (let reload = 0; reload < 3; reload++) {
      const reloaded = createCitationRouter(href);
      await reloaded.load();
      // Route normalization rebuilds the current location from its decoded hash.
      await reloaded.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: citation.environmentId, threadId: citation.threadId },
        hash: true,
        replace: true,
      });
      href = reloaded.history.location.href;
      expect(assistantCitationFromLocation(href)).toEqual(citation);
    }
  });

  it("reactivates an identical citation instead of deduplicating its navigation", async () => {
    const router = createCitationRouter();
    await router.load();
    await router.navigate(assistantCitationNavigation(citation));
    const previous = router.state.location;
    await router.navigate(assistantCitationNavigation(citation));

    expect(router.state.location.href).toBe(previous.href);
    expect(router.state.location.state.assistantCitationActivation).not.toBe(
      previous.state.assistantCitationActivation,
    );
    expect(router.history.length).toBe(3);
    expect(assistantCitationFromLocation(router.state.location.href)).toEqual(citation);
  });

  it("ignores non-citation fragments and missing fragments", () => {
    expect(assistantCitationFromLocation("/environment-one/thread-one")).toBeNull();
    expect(
      assistantCitationFromLocation("/environment-one/thread-one#ordinary-heading"),
    ).toBeNull();
    expect(assistantCitationFromLocation("/a/b#assistant-citation=%invalid")).toBeNull();
    expect(
      assistantCitationFromLocation(`/a/b#assistant-citation=${"a".repeat(140_000)}`),
    ).toBeNull();
  });
});
