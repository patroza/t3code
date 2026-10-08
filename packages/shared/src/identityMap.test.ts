import { describe, expect, it } from "vite-plus/test";

import {
  IdentityMapParseError,
  normalizeJiraAccountId,
  findPersonByMcpClientName,
  findPersonByTeamsActor,
  parseIdentityMapDocument,
  resolvePersonByJiraAccountId,
} from "./identityMap.ts";

describe("parseIdentityMapDocument", () => {
  it("parses people map with usernames", () => {
    const people = parseIdentityMapDocument({
      people: {
        patroza: {
          username: "patroza",
          name: "Patrick Roza",
          discord: { id: "95218063095377920" },
          github: { login: "patroza", id: "42661" },
        },
        julius: {
          username: "Julius",
          name: "Julius",
        },
      },
    });
    expect(people).toHaveLength(2);
    expect(people[0]?.username).toBe("patroza");
    expect(people[1]?.username).toBe("julius");
    expect(people[1]?.personId).toBe("julius");
  });

  it("rejects free-form invalid usernames", () => {
    expect(() =>
      parseIdentityMapDocument({
        people: [{ username: "pat roza", name: "Bad" }],
      }),
    ).toThrow(IdentityMapParseError);
  });

  it("rejects duplicate usernames", () => {
    expect(() =>
      parseIdentityMapDocument({
        people: [
          { username: "a", personId: "a" },
          { username: "a", personId: "b" },
        ],
      }),
    ).toThrow(/duplicate username/);
  });

  it("returns empty for empty document", () => {
    expect(parseIdentityMapDocument({})).toEqual([]);
    expect(parseIdentityMapDocument({ people: [] })).toEqual([]);
  });

  it("resolves people by Jira accountId", () => {
    const people = parseIdentityMapDocument({
      people: {
        patroza: {
          username: "patroza",
          jira: { accountId: "712020:abc" },
        },
      },
    });
    expect(normalizeJiraAccountId("accountid:712020:ABC")).toBe("712020:abc");
    expect(resolvePersonByJiraAccountId(people, "712020:abc")?.username).toBe("patroza");
    expect(resolvePersonByJiraAccountId(people, "nope")).toBeNull();
  });

  it("resolves people by Teams Azure AD object id", () => {
    const people = parseIdentityMapDocument({
      people: {
        patroza: {
          username: "patroza",
          teamsAadObjectId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
          teamsUserId: "29:patroza",
        },
      },
    });
    expect(
      findPersonByTeamsActor(people, { userId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" })?.username,
    ).toBe("patroza");
    expect(findPersonByTeamsActor(people, { userId: "29:patroza" })?.username).toBe("patroza");
    expect(findPersonByTeamsActor(people, { aadObjectId: "nope" })).toBeNull();
  });

  it("reads MCP client names from flat, nested, and list fields", () => {
    const people = parseIdentityMapDocument({
      people: {
        andreasimonecosta: {
          username: "andreasimonecosta",
          name: "Andrea Simone Costa",
          mcpClientName: "mcpx-server",
          mcp: { clientName: "MCPX-Server", clientNames: ["review-bot"] },
        },
      },
    });
    expect(people[0]?.mcpClientNames).toEqual(["mcpx-server", "review-bot"]);
    expect(findPersonByMcpClientName(people, " MCPX-SERVER ")?.username).toBe("andreasimonecosta");
    expect(findPersonByMcpClientName(people, "review-bot")?.name).toBe("Andrea Simone Costa");
    expect(findPersonByMcpClientName(people, "claude code")).toBeNull();
  });

  it("rejects an MCP client name claimed by two people", () => {
    expect(() =>
      parseIdentityMapDocument({
        people: {
          andrea: { username: "andrea", mcpClientName: "mcpx-server" },
          patrick: { username: "patrick", mcp_client_name: "MCPX-Server" },
        },
      }),
    ).toThrow(/duplicate mcp client name/);
  });
});
