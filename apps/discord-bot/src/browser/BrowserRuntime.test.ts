// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import type { Page } from "playwright-core";

import {
  assertUrlAllowed,
  browserStatusForPage,
  browserTabsToEvict,
  captureScreenshotWithCdp,
  matchesExpectedUrl,
  normalizeBrowserUrl,
  readSnapshotPageState,
  saveScreenshotArtifact,
} from "./BrowserRuntime.ts";

describe("browser tab retention", () => {
  it("evicts least-recently-used tabs beyond the retention limit", () => {
    expect(
      browserTabsToEvict(
        ["oldest", "older", "recent", "newest"].map((tabId) => ({
          tabId,
          threadId: "thread-a",
        })),
        new Set(),
        2,
        10,
      ),
    ).toEqual(["oldest", "older"]);
  });

  it("does not evict tabs with in-flight work or recordings", () => {
    expect(
      browserTabsToEvict(
        ["busy-oldest", "recording", "eligible", "newest"].map((tabId) => ({
          tabId,
          threadId: "thread-a",
        })),
        new Set(["busy-oldest", "recording"]),
        3,
        10,
      ),
    ).toEqual(["eligible"]);
  });

  it("allows temporary overflow when every excess tab is protected", () => {
    const tabs = ["busy-a", "busy-b"].map((tabId) => ({ tabId, threadId: "thread-a" }));
    expect(browserTabsToEvict(tabs, new Set(["busy-a", "busy-b"]), 1, 10)).toEqual([]);
  });

  it("enforces a global ceiling across threads", () => {
    const tabs = [
      { tabId: "a-old", threadId: "thread-a" },
      { tabId: "b-old", threadId: "thread-b" },
      { tabId: "a-new", threadId: "thread-a" },
      { tabId: "b-new", threadId: "thread-b" },
    ];
    expect(browserTabsToEvict(tabs, new Set(), 2, 3)).toEqual(["a-old"]);
  });
});

describe("browser URL policy", () => {
  it("normalizes schemeless hosts to HTTPS", () => {
    expect(normalizeBrowserUrl("github.com/login").toString()).toBe("https://github.com/login");
  });

  it("rejects unsafe protocols and non-loopback HTTP", () => {
    expect(() => normalizeBrowserUrl("file:///etc/passwd")).toThrow(/only supports HTTP/);
    expect(() => assertUrlAllowed(new URL("http://example.com"), [])).toThrow(/loopback/);
    expect(() => assertUrlAllowed(new URL("http://127.0.0.1:5173"), [])).not.toThrow();
  });

  it("supports exact and wildcard origin allowlists", () => {
    expect(() =>
      assertUrlAllowed(new URL("https://github.com/x"), ["https://github.com"]),
    ).not.toThrow();
    expect(() =>
      assertUrlAllowed(new URL("https://api.github.com/x"), ["https://*.github.com"]),
    ).not.toThrow();
    expect(() =>
      assertUrlAllowed(new URL("https://example.com"), ["https://*.github.com"]),
    ).toThrow(/not allowed/);
  });

  it("matches verification URL globs", () => {
    expect(
      matchesExpectedUrl("https://github.com/settings/profile", "https://github.com/settings/**"),
    ).toBe(true);
    expect(matchesExpectedUrl("https://github.com/login", "https://github.com/settings/**")).toBe(
      false,
    );
  });
});

describe("browser status", () => {
  it("returns a JSON-safe result when no tab is active", async () => {
    const status = await browserStatusForPage(null, undefined);

    expect(status).toEqual({
      available: false,
      visible: false,
      tabId: null,
      url: null,
      title: null,
      loading: false,
    });
    expect(JSON.parse(JSON.stringify(status))).toEqual(status);
  });
});

describe("browser screenshots", () => {
  it("persists a PNG artifact for the agent to attach", async () => {
    const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-snapshot-test-"));
    const source = Buffer.from("png-content").toString("base64");

    const artifactPath = await saveScreenshotArtifact(dataDir, source);

    expect(NodePath.dirname(artifactPath)).toBe(NodePath.join(dataDir, "browser", "artifacts"));
    await expect(NodeFSP.readFile(artifactPath, "utf8")).resolves.toBe("png-content");
  });

  it("evaluates DOM extraction as browser-native source", async () => {
    let expression: unknown;
    const expected = {
      url: "https://example.com",
      title: "Example",
      loading: false,
      visibleText: "Example",
      interactiveElements: [],
    };
    const page = {
      evaluate: async (input: unknown) => {
        expression = input;
        return expected;
      },
    } as unknown as Page;

    await expect(readSnapshotPageState(page)).resolves.toEqual(expected);
    expect(expression).toEqual(expect.any(String));
    expect(expression).not.toContain("__name");
  });

  it("captures through CDP without invoking Playwright's font-aware screenshot wrapper", async () => {
    let detached = false;
    const page = {
      context: () => ({
        newCDPSession: async () => ({
          send: async () => ({ data: "base64-png" }),
          detach: async () => {
            detached = true;
          },
        }),
      }),
      screenshot: async () => {
        throw new Error("page.screenshot must not be called");
      },
    } as unknown as Page;

    await expect(captureScreenshotWithCdp(page)).resolves.toBe("base64-png");
    expect(detached).toBe(true);
  });

  it("detaches the CDP session when capture fails", async () => {
    let detached = false;
    const page = {
      context: () => ({
        newCDPSession: async () => ({
          send: async () => {
            throw new Error("capture failed");
          },
          detach: async () => {
            detached = true;
          },
        }),
      }),
    } as unknown as Page;

    await expect(captureScreenshotWithCdp(page)).rejects.toThrow("capture failed");
    expect(detached).toBe(true);
  });
});
