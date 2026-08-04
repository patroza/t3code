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
  {
    personId: "andrea",
    username: "andrea",
    name: "Andrea",
    github: { login: "andrea", id: "99" },
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

      expect(result).toContain("The server identity map attributes this work to patroza");
      expect(result).toContain(
        "Co-authored-by: Patrick Roza <42661+patroza@users.noreply.github.com>",
      );
    },
  );

  it("leaves unattributed turns unchanged", () => {
    expect(withAgentIdentityAttribution({ message: "hello", people })).toBe("hello");
  });

  it.each([
    "cab: Patrick Roza <42661+patroza@users.noreply.github.com>",
    "Co-authored-by: Patrick Roza <42661+patroza@users.noreply.github.com>",
  ])("does not duplicate existing Discord attribution: %s", (attribution) => {
    const message = `make the change\n\n${attribution}`;
    const source: SourceRef = {
      channel: "discord",
      personId: PersonId.make("patroza"),
      username: IdentityUsername.make("patroza"),
    };

    expect(withAgentIdentityAttribution({ message, source, people })).toBe(message);
  });

  it("attributes the thread starter and current requester once", () => {
    const threadStarter: SourceRef = {
      channel: "discord",
      personId: PersonId.make("andrea"),
      username: IdentityUsername.make("andrea"),
    };
    const requester: SourceRef = {
      channel: "discord",
      personId: PersonId.make("patroza"),
      username: IdentityUsername.make("patroza"),
    };
    const result = withAgentIdentityAttribution({
      message: "continue the work",
      source: requester,
      additionalSources: [threadStarter, threadStarter],
      people,
    });

    expect(result).toContain("attributes this work to andrea, patroza");
    expect(result).toContain("Co-authored-by: Andrea <99+andrea@users.noreply.github.com>");
    expect(result).toContain(
      "Co-authored-by: Patrick Roza <42661+patroza@users.noreply.github.com>",
    );
    expect(result.match(/Co-authored-by: Andrea/gu)).toHaveLength(1);
  });

  it("adds only a missing requester when legacy Discord supplied the thread starter", () => {
    const threadStarter: SourceRef = {
      channel: "discord",
      personId: PersonId.make("andrea"),
      username: IdentityUsername.make("andrea"),
    };
    const requester: SourceRef = {
      channel: "discord",
      personId: PersonId.make("patroza"),
      username: IdentityUsername.make("patroza"),
    };
    const message = "continue\n\ncab: Andrea <99+andrea@users.noreply.github.com>";
    const result = withAgentIdentityAttribution({
      message,
      source: requester,
      additionalSources: [threadStarter],
      people,
    });

    expect(result.match(/Andrea <99\+andrea@users\.noreply\.github\.com>/gu)).toHaveLength(1);
    expect(result).toContain(
      "Co-authored-by: Patrick Roza <42661+patroza@users.noreply.github.com>",
    );
  });
});
