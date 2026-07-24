import { describe, expect, it } from "vite-plus/test";

import {
  applyModelHistoryUpdate,
  formatModelSinceLabel,
  formatThreadInfoModelLine,
  isThreadInfoPinContent,
  renderThreadInfoPin,
  THREAD_INFO_PIN_MARKER,
} from "./threadInfoPin.ts";

describe("renderThreadInfoPin", () => {
  it("renders model, worktree, open link, ordered jira keys, and PR links", () => {
    const rendered = renderThreadInfoPin({
      modelLine: "grok/grok-4.5",
      worktreeLine: "Worktree off `main`",
      webLink: "http://198.18.83.2:3773/?thread=abc",
      jiraIssueKeys: ["PROJ-367", "PROJ-400"],
      jiraBrowseBaseUrl: "https://example.atlassian.net",
      channelGithubRepoSlug: "example-org/scanner",
      prUrls: [
        "https://github.com/example-org/scanner/pull/1950",
        "https://github.com/example-org/configurator/pull/123",
      ],
    });

    expect(rendered).toContain(`**${THREAD_INFO_PIN_MARKER}**`);
    expect(rendered).toContain("Model: `grok/grok-4.5`");
    expect(rendered).toContain("Worktree off `main`");
    expect(rendered).toContain("Open in Omegent: http://198.18.83.2:3773/?thread=abc");
    expect(rendered).toContain("**Jira**");
    expect(rendered).toContain("[PROJ-367](https://example.atlassian.net/browse/PROJ-367)");
    expect(rendered).toContain("[PROJ-400](https://example.atlassian.net/browse/PROJ-400)");
    expect(rendered.indexOf("PROJ-367")).toBeLessThan(rendered.indexOf("PROJ-400"));
    expect(rendered).toContain("**PRs**");
    expect(rendered).toContain("[PR #1950](https://github.com/example-org/scanner/pull/1950)");
    expect(rendered).toContain(
      "[example-org/configurator PR #123](https://github.com/example-org/configurator/pull/123)",
    );
    expect(rendered.indexOf("**Jira**")).toBeLessThan(rendered.indexOf("**PRs**"));
  });

  it("omits jira and PR sections when empty", () => {
    const rendered = renderThreadInfoPin({
      modelLine: "codex/gpt-5.4",
      worktreeLine: "Mode: local (no worktree)",
      webLink: null,
      jiraIssueKeys: [],
      prUrls: [],
    });
    expect(rendered).not.toContain("**Jira**");
    expect(rendered).not.toContain("**PRs**");
    expect(rendered).toContain("Mode: local (no worktree)");
  });

  it("renders model change note when provided as a full Model: line", () => {
    const rendered = renderThreadInfoPin({
      modelLine: "Model: `grok/grok-4.5` (since 2026-07-20 at 10:05, started with `codex/gpt-5.4`)",
      worktreeLine: "Worktree off `main`",
      webLink: null,
    });
    expect(rendered).toContain("started with `codex/gpt-5.4`");
  });
});

describe("model history", () => {
  it("records initial model without a since stamp", () => {
    const history = applyModelHistoryUpdate(null, "codex/gpt-5.4", "2026-07-20T08:00:00.000Z");
    expect(history).toEqual({
      initialModelLine: "codex/gpt-5.4",
      currentModelLine: "codex/gpt-5.4",
      modelSinceAt: null,
    });
    expect(formatThreadInfoModelLine(history)).toBe("Model: `codex/gpt-5.4`");
  });

  it("stamps since when the model changes and keeps the original", () => {
    const initial = applyModelHistoryUpdate(null, "codex/gpt-5.4", "2026-07-20T08:00:00.000Z");
    const changed = applyModelHistoryUpdate(initial, "grok/grok-4.5", "2026-07-20T08:05:00.000Z");
    expect(changed).toEqual({
      initialModelLine: "codex/gpt-5.4",
      currentModelLine: "grok/grok-4.5",
      modelSinceAt: "2026-07-20T08:05:00.000Z",
    });
    // 08:05 UTC → 10:05 Europe/Berlin (CEST in July)
    expect(formatThreadInfoModelLine(changed)).toBe(
      "Model: `grok/grok-4.5` (since 2026-07-20 at 10:05, started with `codex/gpt-5.4`)",
    );
  });

  it("does not re-stamp when the same model is observed again", () => {
    const changed = applyModelHistoryUpdate(
      {
        initialModelLine: "codex/gpt-5.4",
        currentModelLine: "grok/grok-4.5",
        modelSinceAt: "2026-07-20T08:05:00.000Z",
      },
      "grok/grok-4.5",
      "2026-07-20T09:00:00.000Z",
    );
    expect(changed.modelSinceAt).toBe("2026-07-20T08:05:00.000Z");
  });

  it("formats Germany local since labels without a timezone suffix", () => {
    // Summer (CEST, UTC+2)
    expect(formatModelSinceLabel("2026-07-20T08:05:30.000Z")).toBe("2026-07-20 at 10:05");
    // Winter (CET, UTC+1)
    expect(formatModelSinceLabel("2026-01-15T08:05:30.000Z")).toBe("2026-01-15 at 09:05");
  });
});

describe("isThreadInfoPinContent", () => {
  it("detects marked and legacy bot messages", () => {
    expect(isThreadInfoPinContent(`**${THREAD_INFO_PIN_MARKER}**\nModel: \`x\``)).toBe(true);
    // Legacy pre-rebrand marker is still recognized so old pins are upgraded in place.
    expect(isThreadInfoPinContent("**T3 Thread Info**\nModel: `x`")).toBe(true);
    // Legacy pre-marker message (no marker line, "Open in T3:" label).
    expect(
      isThreadInfoPinContent("Model: `grok/grok-4.5`\nWorktree off `main`\nOpen in T3: http://x"),
    ).toBe(true);
    // New pre-marker-equivalent (no marker line, "Open in Omegent:" label).
    expect(
      isThreadInfoPinContent(
        "Model: `grok/grok-4.5`\nWorktree off `main`\nOpen in Omegent: http://x",
      ),
    ).toBe(true);
    expect(isThreadInfoPinContent("hello world")).toBe(false);
  });
});
