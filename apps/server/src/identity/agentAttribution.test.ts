import { IdentityUsername, PersonId, type SourceRef } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withAgentIdentityAttribution } from "./agentAttribution.ts";

const people = [
  {
    personId: "patroza",
    username: "patroza",
    name: "Patrick Roza",
    github: { login: "patroza", id: "42661" },
  },
] as const;

describe("withAgentIdentityAttribution", () => {
  it.each(["desktop", "web", "discord", "jira", "github"] as const)(
    "applies the mapped identity to %s turns",
    (channel) => {
      const source: SourceRef = {
        channel,
        personId: PersonId.make("patroza"),
        username: IdentityUsername.make("patroza"),
      };
      const result = withAgentIdentityAttribution({ message: "make the change", source, people });

      expect(result).toContain("The server identity map attributes this turn to patroza");
      expect(result).toContain(
        "Co-authored-by: Patrick Roza <42661+patroza@users.noreply.github.com>",
      );
    },
  );

  it("leaves unattributed turns unchanged", () => {
    expect(withAgentIdentityAttribution({ message: "hello", people })).toBe("hello");
  });
});
