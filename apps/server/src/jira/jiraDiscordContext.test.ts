import { describe, expect, it } from "@effect/vitest";

import { formatDiscordJiraContextNote } from "./jiraDiscordContext.ts";

describe("formatDiscordJiraContextNote", () => {
  it("formats a short context note", () => {
    const text = formatDiscordJiraContextNote({
      issueKey: "SA-402",
      requester: "Ada",
      prompt: "packing fails on stage",
      commentUrl: "https://example.atlassian.net/browse/SA-402?focusedCommentId=1",
    });
    expect(text).toContain("SA-402");
    expect(text).toContain("Ada");
    expect(text).toContain("no agent run");
    expect(text).toContain("packing fails on stage");
    expect(text).toContain("focusedCommentId=1");
  });

  it("truncates long prompts to Discord limits", () => {
    const prompt = "x".repeat(3000);
    const text = formatDiscordJiraContextNote({
      issueKey: "SA-1",
      requester: "Bob",
      prompt,
    });
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("…(truncated)");
  });
});
