import { describe, expect, it } from "vite-plus/test";

import { filterPeopleForTypeahead, identityClaimRequired, threadMatchesMine } from "./identity.ts";

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
});
