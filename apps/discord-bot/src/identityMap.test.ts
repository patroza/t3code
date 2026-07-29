// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  formatCoAuthoredByBody,
  formatCoAuthoredByTrailer,
  formatIdentityAttributionBlock,
  loadIdentityMapFromFileSync,
  makeRefreshingIdentityMapStore,
  parseIdentityMapDocument,
  parseSimpleIdentityYaml,
  resolveGitHubCoAuthorEmail,
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

describe("co-author trailers", () => {
  it("derives noreply email from github id + login", () => {
    expect(resolveGitHubCoAuthorEmail({ login: "patroza", id: "12345" })).toBe(
      "12345+patroza@users.noreply.github.com",
    );
  });

  it("prefers explicit email", () => {
    expect(
      resolveGitHubCoAuthorEmail({
        login: "patroza",
        id: "12345",
        email: "me@example.com",
      }),
    ).toBe("me@example.com");
  });

  it("formats co-author body and full trailer", () => {
    expect(
      formatCoAuthoredByBody({
        name: "Patrick Roza",
        github: { login: "patroza", id: "12345" },
      }),
    ).toBe("Patrick Roza <12345+patroza@users.noreply.github.com>");
    expect(
      formatCoAuthoredByTrailer({
        name: "Patrick Roza",
        github: { login: "patroza", id: "12345" },
      }),
    ).toBe("Co-authored-by: Patrick Roza <12345+patroza@users.noreply.github.com>");
  });

  it("returns null without resolvable email", () => {
    expect(
      formatCoAuthoredByTrailer({
        name: "X",
        github: { login: "x" },
      }),
    ).toBeNull();
  });
});

describe("resolveParticipantIdentity + formatIdentityAttributionBlock", () => {
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
    expect(resolved.coAuthoredBy).toContain("patroza");
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

  it("builds compact cab bodies (no Co-authored-by prefix, no who when mapped)", () => {
    const block = formatIdentityAttributionBlock({
      participants: [
        resolveParticipantIdentity({
          role: "thread_starter",
          discordId: "222",
          discordDisplayName: "Davide",
          people,
        }),
        resolveParticipantIdentity({
          role: "requester",
          discordId: "95218063095377920",
          discordDisplayName: "Patrick Roza",
          people,
        }),
      ],
    });
    expect(block).toBe(
      "cab: Davide <99+davide@users.noreply.github.com> | Patrick Roza <12345+patroza@users.noreply.github.com>",
    );
    expect(block).not.toContain("Co-authored-by:");
    expect(block).not.toContain("who:");
    expect(block).not.toContain("unmapped:");
  });

  it("dedupes identical cab when starter is also requester", () => {
    const same = resolveParticipantIdentity({
      role: "requester",
      discordId: "222",
      people,
    });
    const starter = resolveParticipantIdentity({
      role: "thread_starter",
      discordId: "222",
      people,
    });
    const block = formatIdentityAttributionBlock({ participants: [starter, same] });
    expect(block).toBe("cab: Davide <99+davide@users.noreply.github.com>");
    expect(block?.match(/Davide/g)).toHaveLength(1);
  });

  it("lists unmapped participants without inventing cab", () => {
    const block = formatIdentityAttributionBlock({
      participants: [
        resolveParticipantIdentity({
          role: "requester",
          discordId: "999",
          discordUsername: "stranger",
          people,
        }),
      ],
    });
    expect(block).toContain("cab: (none)");
    expect(block).toContain("unmapped: req 999@stranger unmapped");
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
