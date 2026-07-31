import { IdentityUsername, PersonId, type ThreadParticipantSummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claimPersonIdForEnvironment,
  filterPeopleForTypeahead,
  identityClaimRequired,
  isClaimedNonStarterParticipant,
  threadMatchesMine,
} from "./identity.ts";

describe("identityClaimRequired", () => {
  it("is false when identity is off", () => {
    expect(
      identityClaimRequired({ enabled: false, claimRequired: false, people: [] }, { claim: null }),
    ).toBe(false);
  });

  it("is true when map enabled and no claim", () => {
    expect(
      identityClaimRequired(
        {
          enabled: true,
          claimRequired: true,
          people: [
            {
              personId: "patroza" as never,
              username: "patroza" as never,
              links: {},
            },
          ],
        },
        { claim: null },
      ),
    ).toBe(true);
  });
});

describe("filterPeopleForTypeahead", () => {
  const people = [
    {
      personId: "patroza" as never,
      username: "patroza" as never,
      name: "Patrick Roza",
      links: {},
    },
    {
      personId: "julius" as never,
      username: "julius" as never,
      name: "Julius",
      links: {},
    },
  ];

  it("requires min chars", () => {
    expect(filterPeopleForTypeahead(people, "pa", 3)).toEqual([]);
  });

  it("matches username and name after min chars", () => {
    expect(filterPeopleForTypeahead(people, "pat", 3).map((p) => p.username)).toEqual(["patroza"]);
    expect(filterPeopleForTypeahead(people, "roza", 3).map((p) => p.username)).toEqual(["patroza"]);
  });
});

describe("threadMatchesMine", () => {
  it("filters mine vs theirs", () => {
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "patroza",
        mode: "mine",
      }),
    ).toBe(true);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        mode: "mine",
      }),
    ).toBe(false);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        mode: "theirs",
      }),
    ).toBe(true);
  });

  it("excludes both mine and theirs when there is no claim for the env", () => {
    expect(
      threadMatchesMine({
        claimPersonId: null,
        originPersonId: "patroza",
        mode: "mine",
      }),
    ).toBe(false);
    expect(
      threadMatchesMine({
        claimPersonId: null,
        originPersonId: "patroza",
        mode: "theirs",
      }),
    ).toBe(false);
    expect(
      threadMatchesMine({
        claimPersonId: null,
        originPersonId: "patroza",
        mode: "any",
      }),
    ).toBe(true);
  });
});

describe("claimPersonIdForEnvironment", () => {
  it("returns the claim for the thread environment only", () => {
    const map = new Map<string, string | null>([
      ["smart", null],
      ["t3vm", "patroza"],
    ]);
    expect(claimPersonIdForEnvironment(map, "t3vm")).toBe("patroza");
    expect(claimPersonIdForEnvironment(map, "smart")).toBeNull();
    expect(claimPersonIdForEnvironment(map, "missing")).toBeNull();
  });
});

describe("isClaimedNonStarterParticipant", () => {
  const participants = [
    {
      personId: PersonId.make("joshua"),
      username: IdentityUsername.make("joshuadima"),
      firstChannel: "discord",
      firstParticipatedAt: "2026-07-30T12:00:00.000Z",
    },
    {
      personId: PersonId.make("patroza"),
      username: IdentityUsername.make("patroza"),
      firstChannel: "desktop",
      firstParticipatedAt: "2026-07-30T12:01:00.000Z",
    },
  ] satisfies ReadonlyArray<ThreadParticipantSummary>;

  it("marks a claimed person hidden among later participants", () => {
    expect(
      isClaimedNonStarterParticipant({
        claimPersonId: "PATROZA",
        participants,
      }),
    ).toBe(true);
  });

  it("does not redundantly mark the visible starter", () => {
    expect(
      isClaimedNonStarterParticipant({
        claimPersonId: "joshua",
        participants,
      }),
    ).toBe(false);
  });

  it("does not mark an unclaimed or absent person", () => {
    expect(
      isClaimedNonStarterParticipant({
        claimPersonId: null,
        participants,
      }),
    ).toBe(false);
    expect(
      isClaimedNonStarterParticipant({
        claimPersonId: "someone-else",
        participants,
      }),
    ).toBe(false);
  });
});
