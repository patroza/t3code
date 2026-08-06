// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  loadIdentityMapFromFileSync,
  makeRefreshingIdentityMapStore,
  parseIdentityMapDocument,
  parseSimpleIdentityYaml,
  classifyDiscordAgentAccess,
  resolveParticipantIdentity,
} from "./identityMap.ts";

describe("parseIdentityMapDocument", () => {
  it("parses people array with nested identities", () => {
    const people = parseIdentityMapDocument({
      people: [
        {
          name: "Patrick Roza",
          discord: { id: "95218063095377920", username: "patroza" },
          github: { login: "patroza", id: "12345" },
          jira: { accountId: "712020:abc", email: "patrick@example.com" },
        },
      ],
    });
    expect(people).toEqual([
      {
        name: "Patrick Roza",
        discord: { id: "95218063095377920", username: "patroza" },
        github: { login: "patroza", id: "12345" },
        jira: { accountId: "712020:abc", email: "patrick@example.com" },
      },
    ]);
  });

  it("parses people map keyed by discord id with flat fields", () => {
    const people = parseIdentityMapDocument({
      people: {
        "95218063095377920": {
          name: "Patrick Roza",
          githubLogin: "patroza",
          githubId: "12345",
        },
      },
    });
    expect(people[0]?.discord?.id).toBe("95218063095377920");
    expect(people[0]?.github?.login).toBe("patroza");
    expect(people[0]?.github?.id).toBe("12345");
  });

  it("parses top-level map keyed by discord id", () => {
    const people = parseIdentityMapDocument({
      "111": { name: "Davide", githubLogin: "davide", githubId: "9" },
    });
    expect(people).toHaveLength(1);
    expect(people[0]?.name).toBe("Davide");
    expect(people[0]?.discord?.id).toBe("111");
  });

  it("rejects entries without name", () => {
    expect(() =>
      parseIdentityMapDocument({
        people: [{ discord: { id: "1" }, github: { login: "x" } }],
      }),
    ).toThrow(/name/i);
  });
});

describe("parseSimpleIdentityYaml", () => {
  it("parses people block with nested fields", () => {
    const doc = parseSimpleIdentityYaml(`
# comment
people:
  "95218063095377920":
    name: Patrick Roza
    githubLogin: patroza
    githubId: "12345"
    jiraAccountId: 712020:abc
`);
    const people = parseIdentityMapDocument(doc);
    expect(people).toHaveLength(1);
    expect(people[0]?.name).toBe("Patrick Roza");
    expect(people[0]?.discord?.id).toBe("95218063095377920");
    expect(people[0]?.github?.login).toBe("patroza");
    expect(people[0]?.github?.id).toBe("12345");
    expect(people[0]?.jira?.accountId).toBe("712020:abc");
  });
});

describe("resolveParticipantIdentity", () => {
  const people = parseIdentityMapDocument({
    people: [
      {
        name: "Patrick Roza",
        discord: { id: "95218063095377920", username: "patroza" },
        github: { login: "patroza", id: "12345" },
      },
      {
        name: "Davide",
        discord: { id: "222", username: "davide" },
        github: { login: "davide", id: "99" },
      },
    ],
  });

  it("resolves by discord id", () => {
    const resolved = resolveParticipantIdentity({
      role: "requester",
      discordId: "95218063095377920",
      discordUsername: "patroza",
      discordDisplayName: "Patrick Roza",
      people,
    });
    expect(resolved.person?.name).toBe("Patrick Roza");
  });

  it("marks unmapped users", () => {
    const resolved = resolveParticipantIdentity({
      role: "requester",
      discordId: "999",
      people,
    });
    expect(resolved.person).toBeNull();
    expect(resolved.unmappedReason).toContain("not present");
  });

  it("fail-closes Discord agent access when the map is empty", () => {
    const denied = classifyDiscordAgentAccess({
      people: [],
      discordId: "95218063095377920",
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toBe("identity_map_empty");
      expect(denied.userMessage.toLowerCase()).toContain("not authorized");
    }
  });

  it("allows mapped Discord requesters and denies unmapped ones", () => {
    const allowed = classifyDiscordAgentAccess({
      people,
      discordId: "95218063095377920",
      discordUsername: "patroza",
    });
    expect(allowed.allowed).toBe(true);
    if (allowed.allowed) expect(allowed.person.name).toBe("Patrick Roza");

    const denied = classifyDiscordAgentAccess({
      people,
      discordId: "999",
      discordUsername: "stranger",
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.reason).toBe("unmapped_discord_actor");
  });
});

describe("loadIdentityMapFromFileSync", () => {
  it("loads JSON files", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-identity-"));
    const path = NodePath.join(dir, "identity-map.json");
    await NodeFSP.writeFile(
      path,
      JSON.stringify({
        people: [
          {
            name: "A",
            discord: { id: "1" },
            github: { login: "a", id: "2" },
          },
        ],
      }),
      "utf8",
    );
    const people = loadIdentityMapFromFileSync(path);
    expect(people).toHaveLength(1);
    expect(people[0]?.github?.login).toBe("a");
  });

  it("loads YAML files", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-identity-"));
    const path = NodePath.join(dir, "identity-map.yaml");
    await NodeFSP.writeFile(
      path,
      `people:
  "1":
    name: A
    githubLogin: a
    githubId: "2"
`,
      "utf8",
    );
    const people = loadIdentityMapFromFileSync(path);
    expect(people[0]?.discord?.id).toBe("1");
    expect(people[0]?.github?.id).toBe("2");
  });
});

describe("makeRefreshingIdentityMapStore", () => {
  it("reloads after the TTL expires and keeps the prior map on load failure", async () => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-identity-ttl-"));
    const path = NodePath.join(dir, "identity-map.json");
    await NodeFSP.writeFile(
      path,
      JSON.stringify({
        people: [
          {
            name: "A",
            discord: { id: "1" },
            github: { login: "a", id: "11" },
          },
        ],
      }),
      "utf8",
    );

    let now = 1_000_000;
    let loads = 0;
    const store = makeRefreshingIdentityMapStore({
      filePath: path,
      ttlMs: 60_000,
      now: () => now,
      load: (p) => {
        loads += 1;
        return loadIdentityMapFromFileSync(p);
      },
    });

    expect(store.list()).toHaveLength(1);
    expect(store.resolveByDiscordId("1")?.name).toBe("A");
    expect(loads).toBe(1);

    // Within TTL — no reload
    now += 30_000;
    expect(store.list()).toHaveLength(1);
    expect(loads).toBe(1);

    // After TTL — pick up new file contents
    await NodeFSP.writeFile(
      path,
      JSON.stringify({
        people: [
          {
            name: "A",
            discord: { id: "1" },
            github: { login: "a", id: "11" },
          },
          {
            name: "Davide Di Pumpo",
            discord: { id: "150802733316702208" },
            github: { login: "MakhBeth", id: "2373426" },
          },
        ],
      }),
      "utf8",
    );
    now += 60_000;
    expect(store.list()).toHaveLength(2);
    expect(store.resolveByDiscordId("150802733316702208")?.github?.login).toBe("MakhBeth");
    expect(loads).toBe(2);

    // Corrupt file after TTL — keep last good snapshot
    await NodeFSP.writeFile(path, "{ not valid json", "utf8");
    now += 60_000;
    expect(store.list()).toHaveLength(2);
    expect(store.resolveByDiscordId("150802733316702208")?.name).toBe("Davide Di Pumpo");
    expect(loads).toBe(3);
  });
});
