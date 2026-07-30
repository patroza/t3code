import { describe, expect, it } from "vite-plus/test";

import { parseIdentityMapDocument, IdentityMapParseError } from "./identityMap.ts";

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
});
