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
  it("filters mine vs theirs when threads are person-attributed", () => {
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

  it("treats unattributed threads as mine (legacy / channel-only / identity off)", () => {
    // No origin or participants — old threads, { channel: "desktop" } only, etc.
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: null,
        participantPersonIds: [],
        mode: "mine",
      }),
    ).toBe(true);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: null,
        participantPersonIds: [],
        mode: "theirs",
      }),
    ).toBe(false);
    // Identity-disabled env: no claim, no person tags → Mine still shows work.
    expect(
      threadMatchesMine({
        claimPersonId: null,
        originPersonId: undefined,
        participantPersonIds: undefined,
        mode: "mine",
      }),
    ).toBe(true);
    expect(
      threadMatchesMine({
        claimPersonId: null,
        originPersonId: undefined,
        mode: "theirs",
      }),
    ).toBe(false);
  });

  it("treats attributed threads without a session claim as theirs", () => {
    expect(
      threadMatchesMine({
        claimPersonId: null,
        originPersonId: "julius",
        mode: "mine",
      }),
    ).toBe(false);
    expect(
      threadMatchesMine({
        claimPersonId: null,
        originPersonId: "julius",
        mode: "theirs",
      }),
    ).toBe(true);
  });

  it("includes participant-only matches as mine", () => {
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        participantPersonIds: ["patroza"],
        mode: "mine",
      }),
    ).toBe(true);
  });

  it("supports created / participated / both relation sub-filters", () => {
    // Mine: created is origin only; participated is join-without-start
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "patroza",
        participantPersonIds: ["julius"],
        mode: "mine",
        relation: "created",
      }),
    ).toBe(true);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        participantPersonIds: ["patroza"],
        mode: "mine",
        relation: "created",
      }),
    ).toBe(false);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        participantPersonIds: ["patroza"],
        mode: "mine",
        relation: "participated",
      }),
    ).toBe(true);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "patroza",
        participantPersonIds: [],
        mode: "mine",
        relation: "participated",
      }),
    ).toBe(false);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        participantPersonIds: ["patroza"],
        mode: "mine",
        relation: "both",
      }),
    ).toBe(true);

    // Theirs never includes threads I joined — Created is not wider than Both
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        participantPersonIds: ["patroza"],
        mode: "theirs",
        relation: "created",
      }),
    ).toBe(false);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        participantPersonIds: ["patroza"],
        mode: "theirs",
        relation: "both",
      }),
    ).toBe(false);
    // Foreign thread: others started → theirs for created and both
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        participantPersonIds: ["alice"],
        mode: "theirs",
        relation: "created",
      }),
    ).toBe(true);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: "julius",
        participantPersonIds: ["alice"],
        mode: "theirs",
        relation: "both",
      }),
    ).toBe(true);
    // Foreign with participants only (no origin): participated ⊆ both, not created
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: null,
        participantPersonIds: ["julius"],
        mode: "theirs",
        relation: "created",
      }),
    ).toBe(false);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: null,
        participantPersonIds: ["julius"],
        mode: "theirs",
        relation: "participated",
      }),
    ).toBe(true);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: null,
        participantPersonIds: ["julius"],
        mode: "theirs",
        relation: "both",
      }),
    ).toBe(true);

    // Fully unattributed only under mine + both
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: null,
        participantPersonIds: [],
        mode: "mine",
        relation: "created",
      }),
    ).toBe(false);
    expect(
      threadMatchesMine({
        claimPersonId: "patroza",
        originPersonId: null,
        participantPersonIds: [],
        mode: "mine",
        relation: "both",
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
