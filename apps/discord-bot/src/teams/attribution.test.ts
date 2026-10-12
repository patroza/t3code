import { describe, expect, it } from "vite-plus/test";
import { teamsMessageActionPrompt } from "./attribution.ts";

const author = {
  name: "Mapped author",
  teams: { aadObjectId: "00000000-0000-4000-8000-000000000001" },
};
const requester = {
  name: "Mapped requester",
  teams: { aadObjectId: "00000000-0000-4000-8000-000000000002" },
};

describe("Teams message action attribution", () => {
  it("preserves selected-message author separately from the requester and reply context", () => {
    const prompt = teamsMessageActionPrompt({
      message: {
        id: "reply",
        replyToId: "root",
        from: { user: { id: author.teams.aadObjectId, displayName: "Spoofed name" } },
        body: { content: "<p>Fix this</p>" },
      },
      requester,
      people: [author, requester],
      instructions: "Investigate",
    });
    expect(prompt).toContain("Requested by: Mapped requester");
    expect(prompt).toContain("Selected message author: Mapped author");
    expect(prompt).not.toContain("Spoofed name");
    expect(prompt).toContain("Selected message ID: reply");
    expect(prompt).toContain("Reply to message ID: root");
    expect(prompt).toContain("Fix this");
  });

  it("does not invent a mapped author for an unknown selected message", () => {
    const prompt = teamsMessageActionPrompt({
      message: { id: "selected", body: { content: "Please investigate" } },
      requester,
      people: [author, requester],
      instructions: "",
    });
    expect(prompt).toContain("Selected message author: Unknown");
    expect(prompt).toContain("Requested by: Mapped requester");
    expect(prompt).not.toContain("Selected message author: Mapped requester");
  });
});
