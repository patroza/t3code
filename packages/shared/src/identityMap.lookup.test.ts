import { describe, expect, it } from "vite-plus/test";

import {
  findPersonByDiscordId,
  findPersonByGithubId,
  findPersonByGithubLogin,
  findPersonByJiraAccountId,
  findPersonByJiraEmail,
  parseIdentityMapDocument,
} from "./identityMap.ts";

const people = parseIdentityMapDocument({
  people: {
    patroza: {
      username: "patroza",
      name: "Patrick",
      discord: { id: "95218063095377920" },
      github: { login: "patroza", id: "42661" },
      jira: { accountId: "jira-pat", email: "patrick@example.com" },
    },
    julius: {
      username: "julius",
      github: { login: "juliusmarminge" },
    },
  },
});

describe("identity map platform lookups", () => {
  it("finds by discord id", () => {
    expect(findPersonByDiscordId(people, "95218063095377920")?.username).toBe("patroza");
    expect(findPersonByDiscordId(people, "0")).toBeNull();
  });

  it("finds by github login and id", () => {
    expect(findPersonByGithubLogin(people, "Patroza")?.username).toBe("patroza");
    expect(findPersonByGithubId(people, 42661)?.username).toBe("patroza");
  });

  it("finds by jira account and email", () => {
    expect(findPersonByJiraAccountId(people, "jira-pat")?.username).toBe("patroza");
    expect(findPersonByJiraEmail(people, "patrick@example.com")?.username).toBe("patroza");
  });
});
