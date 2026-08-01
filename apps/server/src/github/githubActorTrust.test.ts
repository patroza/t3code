import { describe, expect, it } from "@effect/vitest";

import { classifyGitHubActorTrust, resolvePersonByGitHubActor } from "./githubActorTrust.ts";

const people = [
  {
    personId: "patroza",
    username: "patroza",
    name: "Patrick Roza",
    github: { login: "patroza", id: "42661" },
  },
  {
    personId: "julius",
    username: "julius",
    github: { login: "juliusmarminge" },
  },
] as const;

describe("resolvePersonByGitHubActor", () => {
  it("prefers github id over login", () => {
    const hit = resolvePersonByGitHubActor(people, {
      actorId: 42661,
      actorLogin: "someone-else",
    });
    expect(hit?.person.username).toBe("patroza");
    expect(hit?.reason).toBe("mapped_github_id");
  });

  it("falls back to login (case-insensitive)", () => {
    const hit = resolvePersonByGitHubActor(people, {
      actorId: 999,
      actorLogin: "JuliusMarminge",
    });
    expect(hit?.person.username).toBe("julius");
    expect(hit?.reason).toBe("mapped_github_login");
  });

  it("returns null when unmapped", () => {
    expect(
      resolvePersonByGitHubActor(people, { actorId: 1, actorLogin: "random-user" }),
    ).toBeNull();
  });
});

describe("classifyGitHubActorTrust", () => {
  it("denies agent access when the identity map is disabled (fail-closed)", () => {
    expect(
      classifyGitHubActorTrust({
        identityMapEnabled: false,
        actorId: 1,
        actorLogin: "stranger",
        people: [],
      }),
    ).toEqual({ mode: "denied", person: null, reason: "identity_map_disabled" });
  });

  it("trusts mapped github accounts for full agent turns", () => {
    const byId = classifyGitHubActorTrust({
      identityMapEnabled: true,
      actorId: "42661",
      actorLogin: "patroza",
      people,
    });
    expect(byId.mode).toBe("full");
    expect(byId.reason).toBe("mapped_github_id");
    expect(byId.person?.username).toBe("patroza");
  });

  it("denies unmapped actors when the map is on (public write is not enough)", () => {
    expect(
      classifyGitHubActorTrust({
        identityMapEnabled: true,
        actorId: 42,
        actorLogin: "drive-by-collaborator",
        people,
      }),
    ).toMatchObject({ mode: "denied", reason: "unmapped_github_actor", person: null });
  });

  it("denies missing actor fields when the map is on", () => {
    expect(
      classifyGitHubActorTrust({
        identityMapEnabled: true,
        actorId: null,
        actorLogin: "",
        people,
      }),
    ).toMatchObject({ mode: "denied", reason: "missing_github_actor" });
  });
});
