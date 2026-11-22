import { describe, expect, it } from "@effect/vitest";

import {
  classifyJiraActorTrust,
  normalizeJiraAccountId,
  resolvePersonByJiraAccountId,
} from "./jiraActorTrust.ts";

const people = [
  {
    personId: "patroza",
    username: "patroza",
    name: "Patrick Roza",
    jira: { accountId: "712020:abc-trusted" },
  },
  {
    personId: "julius",
    username: "julius",
    jira: { accountId: "accountid:712020:def-other" },
  },
] as const;

describe("normalizeJiraAccountId", () => {
  it("strips accountid: prefix and lowercases", () => {
    expect(normalizeJiraAccountId("accountid:712020:ABC")).toBe("712020:abc");
    expect(normalizeJiraAccountId("712020:ABC")).toBe("712020:abc");
  });

  it("returns null for empty", () => {
    expect(normalizeJiraAccountId(null)).toBeNull();
    expect(normalizeJiraAccountId("  ")).toBeNull();
  });
});

describe("resolvePersonByJiraAccountId", () => {
  it("matches mapped account ids with prefix variants", () => {
    expect(resolvePersonByJiraAccountId(people, "712020:abc-trusted")?.username).toBe("patroza");
    expect(resolvePersonByJiraAccountId(people, "accountid:712020:ABC-TRUSTED")?.username).toBe(
      "patroza",
    );
    expect(resolvePersonByJiraAccountId(people, "712020:def-other")?.username).toBe("julius");
  });

  it("returns null when unmapped", () => {
    expect(resolvePersonByJiraAccountId(people, "unknown")).toBeNull();
  });
});

describe("classifyJiraActorTrust", () => {
  it("denies agent access when the identity map is disabled (fail-closed)", () => {
    expect(
      classifyJiraActorTrust({
        identityMapEnabled: false,
        actorAccountId: "stranger",
        people: [],
      }),
    ).toEqual({ mode: "context-only", person: null, reason: "identity_map_disabled" });
  });

  it("trusts mapped Jira account ids for full agent turns", () => {
    const decision = classifyJiraActorTrust({
      identityMapEnabled: true,
      actorAccountId: "712020:abc-trusted",
      people,
    });
    expect(decision.mode).toBe("full");
    expect(decision.reason).toBe("mapped_jira_account");
    expect(decision.person?.username).toBe("patroza");
  });

  it("restricts unmapped and missing account ids to context-only", () => {
    expect(
      classifyJiraActorTrust({
        identityMapEnabled: true,
        actorAccountId: "712020:stranger",
        people,
      }),
    ).toMatchObject({ mode: "context-only", reason: "unmapped_jira_account", person: null });

    expect(
      classifyJiraActorTrust({
        identityMapEnabled: true,
        actorAccountId: null,
        people,
      }),
    ).toMatchObject({ mode: "context-only", reason: "missing_jira_account_id", person: null });
  });
});
