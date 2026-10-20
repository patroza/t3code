import { describe, expect, it } from "vite-plus/test";

import {
  planBackgroundDigestAppend,
  renderWatchingDigest,
  turnFoldsIntoWatchDigest,
  WATCHING_INDICATOR,
} from "./backgroundDigest.ts";

const watch = [{ watch: { startedAt: "2026-10-20T00:00:00.000Z" } }];
const monitor = {
  role: "user" as const,
  turnId: "turn-1",
  text: "Update on pull request #12, which T3 Code is watching for you:",
  notification: { source: { kind: "monitor" }, summary: "#12: checks finished" },
};

describe("planBackgroundDigestAppend", () => {
  it("edits one message until the next update does not fit", () => {
    const first = planBackgroundDigestAppend({
      liveText: "",
      update: "Release Smoke passed.",
      limit: 200,
    });
    expect(first.writes).toEqual([
      { text: renderWatchingDigest("Release Smoke passed."), live: true },
    ]);

    const second = planBackgroundDigestAppend({
      liveText: first.liveText,
      update: "Check passed. Test is still running.",
      limit: 200,
    });
    expect(second.writes).toHaveLength(1);
    expect(second.writes[0]?.live).toBe(true);
    expect(second.writes[0]?.text).toContain("Release Smoke passed.");
    expect(second.writes[0]?.text).toContain("Check passed. Test is still running.");
    expect(second.writes[0]?.text.endsWith(WATCHING_INDICATOR)).toBe(true);
  });

  it("freezes the full message and continues in a new one", () => {
    const prior = "A".repeat(40);
    const plan = planBackgroundDigestAppend({
      liveText: prior,
      update: "B".repeat(40),
      limit: 80,
    });
    expect(plan.writes.map((write) => write.live)).toEqual([false, true]);
    expect(plan.writes[0]?.text).toBe(prior);
    expect(plan.writes[0]?.text).not.toContain("Watching");
    expect(plan.writes[1]?.text).toContain("B");
    expect(plan.writes[1]?.text.endsWith(WATCHING_INDICATOR)).toBe(true);
    expect(plan.liveText.length).toBeLessThanOrEqual(80);
  });

  it("splits one update that is longer than a message", () => {
    const plan = planBackgroundDigestAppend({
      liveText: "",
      update: "C".repeat(120),
      limit: 50,
    });
    expect(plan.writes.length).toBeGreaterThan(1);
    expect(plan.writes.at(-1)?.live).toBe(true);
    expect(plan.writes.slice(0, -1).every((write) => write.live === false)).toBe(true);
    for (const write of plan.writes) {
      expect(write.text.length).toBeLessThanOrEqual(50);
    }
  });
});

describe("turnFoldsIntoWatchDigest", () => {
  it("folds an open pull-request watch wake", () => {
    expect(
      turnFoldsIntoWatchDigest({
        turnId: "turn-1",
        messages: [monitor],
        pullRequests: watch,
        hasAttachments: false,
      }),
    ).toBe(true);
  });

  it("posts a final when the watch has ended", () => {
    expect(
      turnFoldsIntoWatchDigest({
        turnId: "turn-1",
        messages: [monitor],
        pullRequests: [{ watch: undefined }],
        hasAttachments: false,
      }),
    ).toBe(false);
    expect(
      turnFoldsIntoWatchDigest({
        turnId: "turn-1",
        messages: [
          {
            ...monitor,
            notification: { source: { kind: "monitor" }, summary: "#12: closed, stopped watching" },
          },
        ],
        pullRequests: watch,
        hasAttachments: false,
      }),
    ).toBe(false);
  });

  it("leaves ordinary turns and attachment replies as finals", () => {
    expect(
      turnFoldsIntoWatchDigest({
        turnId: "turn-1",
        messages: [{ role: "user", turnId: "turn-1", text: "please check this" }],
        pullRequests: watch,
        hasAttachments: false,
      }),
    ).toBe(false);
    expect(
      turnFoldsIntoWatchDigest({
        turnId: "turn-1",
        messages: [monitor],
        pullRequests: watch,
        hasAttachments: true,
      }),
    ).toBe(false);
  });
});
