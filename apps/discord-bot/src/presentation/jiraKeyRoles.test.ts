import { describe, expect, it } from "@effect/vitest";

import {
  excludeBotOnlyKeysAcrossLinks,
  linkNeedsJiraRoleScan,
  mergePromotedLinkedKeys,
  splitJiraKeysForPinAndLink,
} from "./jiraKeyRoles.ts";

describe("splitJiraKeysForPinAndLink", () => {
  it("keeps bot-only prose on the pin and out of the link set", () => {
    const split = splitJiraKeysForPinAndLink({
      existingPinKeys: ["SA-470", "SA-465"],
      humanKeys: [],
      botKeys: ["SA-470", "SA-465"],
    });
    expect(split.pinKeys).toEqual(["SA-470", "SA-465"]);
    expect(split.linkedKeys).toEqual([]);
    expect(split.backfillKeys).toEqual(["SA-470", "SA-465"]);
  });

  it("keeps a human-pasted key linkable and does not link new bot prose", () => {
    const split = splitJiraKeysForPinAndLink({
      existingPinKeys: ["SA-100"],
      existingLinkedKeys: ["SA-100"],
      humanKeys: ["SA-100"],
      botKeys: ["SA-465"],
    });
    expect(split.pinKeys).toEqual(["SA-100", "SA-465"]);
    expect(split.linkedKeys).toEqual(["SA-100"]);
    expect(split.backfillKeys).toEqual(["SA-465"]);
  });

  it("leaves pin keys that are outside the scanned window linkable", () => {
    const split = splitJiraKeysForPinAndLink({
      existingPinKeys: ["SA-100"],
      humanKeys: [],
      botKeys: [],
    });
    expect(split.linkedKeys).toEqual(["SA-100"]);
    expect(split.backfillKeys).toEqual([]);
  });
});

describe("excludeBotOnlyKeysAcrossLinks", () => {
  it("drops a key from the joined thread when an older thread only saw it from the bot", () => {
    const [original, joined] = excludeBotOnlyKeysAcrossLinks([
      {
        t3ThreadId: "t-330",
        botOnlyKeys: ["SA-465"],
        linkedKeys: [],
      },
      {
        t3ThreadId: "t-330",
        botOnlyKeys: [],
        linkedKeys: ["SA-465"],
      },
    ]);
    expect(original?.linkedKeys).toEqual([]);
    expect(joined?.linkedKeys).toEqual([]);
  });

  it("keeps a key a turn already promoted", () => {
    const [row] = excludeBotOnlyKeysAcrossLinks([
      {
        t3ThreadId: "t-330",
        botOnlyKeys: ["SA-465"],
        linkedKeys: ["SA-465"],
        explicitLinkedKeys: ["SA-465"],
      },
    ]);
    expect(row?.linkedKeys).toEqual(["SA-465"]);
  });
});

describe("linkNeedsJiraRoleScan", () => {
  it("scans every active link and each unsplit tombstone that still has pin keys", () => {
    expect(linkNeedsJiraRoleScan({ status: "active" })).toBe(true);
    expect(
      linkNeedsJiraRoleScan({
        status: "tombstone",
        jiraIssueKeys: ["SA-465"],
      }),
    ).toBe(true);
    expect(
      linkNeedsJiraRoleScan({
        status: "tombstone",
        jiraIssueKeys: ["SA-465"],
        linkedJiraIssueKeys: [],
        backfillJiraIssueKeys: ["SA-465"],
      }),
    ).toBe(false);
    expect(linkNeedsJiraRoleScan({ status: "tombstone" })).toBe(false);
  });
});

describe("mergePromotedLinkedKeys", () => {
  it("keeps a key a turn promoted while the backfill scan was still running", () => {
    const merged = mergePromotedLinkedKeys({
      classifiedLinkedKeys: [],
      classifiedBackfillKeys: ["SA-465"],
      linkedKeysAtStart: undefined,
      linkedKeysNow: ["SA-465"],
    });
    expect(merged.linkedKeys).toEqual(["SA-465"]);
    expect(merged.backfillKeys).toEqual([]);
  });

  it("does not treat the pre-scan link set as a new promotion", () => {
    const merged = mergePromotedLinkedKeys({
      classifiedLinkedKeys: ["SA-100"],
      classifiedBackfillKeys: ["SA-465"],
      linkedKeysAtStart: ["SA-100"],
      linkedKeysNow: ["SA-100"],
    });
    expect(merged.linkedKeys).toEqual(["SA-100"]);
    expect(merged.backfillKeys).toEqual(["SA-465"]);
  });
});
