// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  channelWeek,
  rememberChannelWeek,
  teamsWeekBucket,
  weeklyThreadKey,
} from "./weeklyThreads.ts";

describe("teamsWeekBucket", () => {
  it("names the Monday that starts the week", () => {
    expect(teamsWeekBucket(new Date("2026-11-23T12:00:00Z"))).toBe("week-2026-11-23");
    expect(teamsWeekBucket(new Date("2026-11-26T12:00:00Z"))).toBe("week-2026-11-23");
    expect(teamsWeekBucket(new Date("2026-11-29T12:00:00Z"))).toBe("week-2026-11-23");
  });

  it("rolls over at Monday midnight in Amsterdam, not UTC", () => {
    // 23:30 UTC on Sunday is already 00:30 on Monday in Amsterdam (CET, UTC+1).
    expect(teamsWeekBucket(new Date("2026-11-29T23:30:00Z"))).toBe("week-2026-11-30");
    expect(teamsWeekBucket(new Date("2026-11-29T22:59:00Z"))).toBe("week-2026-11-23");
  });

  it("crosses month and year boundaries", () => {
    expect(teamsWeekBucket(new Date("2027-01-01T09:00:00Z"))).toBe("week-2026-12-28");
  });

  it("appends the bucket to a location key", () => {
    expect(weeklyThreadKey("native/t/group/19:chat", new Date("2026-11-24T09:00:00Z"))).toBe(
      "native/t/group/19:chat/week-2026-11-23",
    );
  });
});

describe("channelWeek", () => {
  const dirs: Array<string> = [];
  const dataDir = () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "teams-weekly-"));
    dirs.push(dir);
    return dir;
  };
  afterEach(() => {
    for (const dir of dirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  const at = new Date("2026-11-24T09:00:00Z");
  const channel = { tenantId: "t", teamId: "team", channelId: "ch" };

  it("does not apply outside channels", () => {
    expect(
      channelWeek({
        dataDir: dataDir(),
        tenantId: "t",
        teamId: undefined,
        channelId: undefined,
        at,
      }),
    ).toBeNull();
  });

  it("lets later reply chains join the thread the first chain opened this week", async () => {
    const dir = dataDir();
    const first = channelWeek({ dataDir: dir, ...channel, at });
    expect(first?.joinT3ThreadId).toBeUndefined();
    await rememberChannelWeek(first, { threadId: "thread-1", isNew: true });

    expect(channelWeek({ dataDir: dir, ...channel, at })?.joinT3ThreadId).toBe("thread-1");
    // A later chain opening its own thread (e.g. the week's thread was gone) keeps the first one.
    await rememberChannelWeek(channelWeek({ dataDir: dir, ...channel, at }), {
      threadId: "thread-2",
      isNew: true,
    });
    expect(channelWeek({ dataDir: dir, ...channel, at })?.joinT3ThreadId).toBe("thread-1");
  });

  it("starts fresh next week and keeps channels apart", async () => {
    const dir = dataDir();
    await rememberChannelWeek(channelWeek({ dataDir: dir, ...channel, at }), {
      threadId: "thread-1",
      isNew: true,
    });
    const nextWeek = new Date("2026-12-01T09:00:00Z");
    expect(channelWeek({ dataDir: dir, ...channel, at: nextWeek })?.joinT3ThreadId).toBeUndefined();
    expect(
      channelWeek({ dataDir: dir, ...channel, channelId: "other", at })?.joinT3ThreadId,
    ).toBeUndefined();
  });

  it("ignores continued threads", async () => {
    const dir = dataDir();
    const week = channelWeek({ dataDir: dir, ...channel, at });
    await rememberChannelWeek(week, { threadId: "old-chain-thread", isNew: false });
    expect(channelWeek({ dataDir: dir, ...channel, at })?.joinT3ThreadId).toBeUndefined();
  });
});
