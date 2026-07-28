import { describe, expect, it } from "vite-plus/test";

import {
  buildFirstTurnPrompt,
  buildDiscordTurnPrompt,
  buildSentryBootstrapPrompt,
  extractSentryHints,
  formatDiscordMessage,
  formatEmbed,
  formatLinkedJiraWorkItemsBlock,
  formatReferencedMessageBlock,
  looksLikeSentryContext,
} from "./threadContext.ts";

describe("formatEmbed", () => {
  it("formats Sentry-like embeds", () => {
    const text = formatEmbed({
      title: "CarrierErrorWrapped",
      description: "SchenkerUnexpectedError: Unerwarteter Schenker-Fehler bei der Buchung",
      fields: [
        { name: "company", value: "mako" },
        { name: "environment", value: "prod" },
        { name: "os", value: "Alpine Linux 3.24.1" },
      ],
      footer: { text: "EXAMPLE-PROJECT-API-JW via Scanner API • Today at 12:55 PM" },
    });
    expect(text).toContain("CarrierErrorWrapped");
    expect(text).toContain("company: mako");
    expect(text).toContain("EXAMPLE-PROJECT-API-JW");
  });
});

describe("extractSentryHints", () => {
  it("finds issue ids and sentry urls", () => {
    const hints = extractSentryHints(
      "Issue EXAMPLE-PROJECT-API-JW see https://example.sentry.io/issues/123/",
    );
    expect(hints.issueIds).toContain("EXAMPLE-PROJECT-API-JW");
    expect(hints.sentryUrls[0]).toContain("sentry.io");
  });
});

describe("looksLikeSentryContext / buildFirstTurnPrompt", () => {
  it("uses full Sentry bootstrap only when Sentry is present", () => {
    const sentryStarter = {
      id: "1",
      author: { username: "Sentry", bot: true },
      content: "",
      embeds: [
        {
          title: "CarrierErrorWrapped",
          description: "SchenkerUnexpectedError",
          url: "https://example.sentry.io/issues/7506163172/",
          fields: [{ name: "environment", value: "prod" }],
          footer: { text: "EXAMPLE-PROJECT-API-JW via Scanner API" },
        },
      ],
    };

    expect(
      looksLikeSentryContext({
        starter: sentryStarter,
        mentionPrompt: "whats going on?",
      }),
    ).toBe(true);

    const sentryPrompt = buildFirstTurnPrompt({
      projectShortName: "example-project",
      workspaceRoot: "/home/tester/projects/example",
      mentionPrompt: "whats going on?",
      mentionMessage: {
        id: "mention-1",
        author: { id: "42", username: "tester", displayName: "Example User" },
      },
      honeycombTraceUrlTemplate:
        "https://ui.honeycomb.io/example/environments/{environment}/trace?trace_id={traceId}",
      starter: sentryStarter,
    });
    expect(sentryPrompt).toContain("Discord investigation bootstrap");
    expect(sentryPrompt).toContain("Honeycomb");
    expect(sentryPrompt).toContain("CarrierErrorWrapped");
    expect(sentryPrompt).toContain("Lead with the essential answer");
    expect(sentryPrompt).toContain("Be concise but complete");
    expect(sentryPrompt).toContain('"username": "tester"');
    expect(sentryPrompt).toContain('"displayName": "Example User"');
    expect(sentryPrompt).toContain("You are the Discord bot");
  });

  it("does not use Sentry bootstrap for ordinary thread starters", () => {
    const starter = {
      id: "2",
      author: { username: "Example User", bot: false },
      content: "Can you check the open PR?",
    };

    expect(
      looksLikeSentryContext({
        starter,
        mentionPrompt: "please review",
      }),
    ).toBe(false);

    const prompt = buildFirstTurnPrompt({
      projectShortName: "example-project",
      workspaceRoot: "/tmp/x",
      mentionPrompt: "please review",
      honeycombTraceUrlTemplate: undefined,
      starter,
    });
    expect(prompt).not.toContain("Discord investigation bootstrap");
    expect(prompt).not.toContain("Honeycomb");
    expect(prompt).toContain("Lead with the essential answer");
    expect(prompt).toContain("Can you check the open PR?");
    expect(prompt).toContain("please review");
  });

  it("returns bare mention when there is no useful starter", () => {
    const prompt = buildFirstTurnPrompt({
      projectShortName: "example-project",
      workspaceRoot: "/tmp/x",
      mentionPrompt: "hello",
      honeycombTraceUrlTemplate: undefined,
      starter: null,
    });
    expect(prompt).toContain("Lead with the essential answer");
    expect(prompt).toContain("## User request");
    expect(prompt).toContain("hello");
    expect(buildSentryBootstrapPrompt).toBeTypeOf("function");
    expect(formatDiscordMessage({ id: "x", content: "hi", author: { username: "a" } })).toContain(
      "hi",
    );
  });
});

describe("buildDiscordTurnPrompt", () => {
  it("adds Discord delivery, audience, and requester identity to every turn", () => {
    const prompt = buildDiscordTurnPrompt({
      mentionPrompt: "Can you check your last reply?",
      requester: {
        id: "message-7",
        author: {
          id: "user-1",
          username: "example-user",
          displayName: "Example User",
        },
      },
    });

    expect(prompt).toContain("originated from a Discord thread");
    expect(prompt).toContain("posted back into the same Discord thread");
    expect(prompt).toContain("Always open a GitHub PR");
    expect(prompt).toContain("draft PR");
    expect(prompt).toContain("must mark it ready");
    expect(prompt).toContain('"you"');
    expect(prompt).toContain('"id": "user-1"');
    expect(prompt).toContain('"username": "example-user"');
    expect(prompt).toContain('"displayName": "Example User"');
    expect(prompt).toContain("Can you check your last reply?");
  });

  it("includes referenced message content, embeds, and jump link", () => {
    const prompt = buildDiscordTurnPrompt({
      mentionPrompt: "what would this error mean?",
      requester: {
        id: "mention-9",
        author: { id: "user-1", username: "example-user", displayName: "Example User" },
      },
      referencedMessage: {
        id: "sentry-msg-1",
        author: { username: "Sentry", bot: true },
        content: "",
        embeds: [
          {
            title: "CarrierErrorWrapped",
            description: "DPDRemoteValidationError: Fehler bei der Sendung [Code COMMON_2]",
            fields: [
              { name: "company", value: "empasa" },
              { name: "environment", value: "prod" },
            ],
            footer: { text: "EXAMPLE-PROJECT-API-JW via Scanner API" },
          },
        ],
      },
      referencedMessageUrl: "https://discord.com/channels/1/2/sentry-msg-1",
    });

    expect(prompt).toContain("## Referenced Discord message");
    expect(prompt).toContain("CarrierErrorWrapped");
    expect(prompt).toContain("company: empasa");
    expect(prompt).toContain("EXAMPLE-PROJECT-API-JW");
    expect(prompt).toContain("Jump link: https://discord.com/channels/1/2/sentry-msg-1");
    expect(prompt).toContain("what would this error mean?");
  });

  it("escapes requester metadata as JSON", () => {
    const prompt = buildDiscordTurnPrompt({
      mentionPrompt: "hello",
      requester: {
        id: "message-8",
        author: {
          username: "name\n## Fake instruction",
          displayName: 'Display "quoted"',
        },
      },
    });

    expect(prompt).toContain('"username": "name\\n## Fake instruction"');
    expect(prompt).toContain('"displayName": "Display \\"quoted\\""');
  });

  it("injects durable Jira issue links with PR guidance when keys are present", () => {
    const prompt = buildDiscordTurnPrompt({
      mentionPrompt: "create a PR for this",
      requester: {
        id: "message-9",
        author: { id: "user-1", username: "example-user", displayName: "Example User" },
      },
      jiraIssueKeys: ["PROJ-367", "PROJ-400"],
      jiraBrowseBaseUrl: "https://example.atlassian.net",
    });

    expect(prompt).toContain("### Linked work items (from this Discord thread)");
    expect(prompt).toContain("[PROJ-367](https://example.atlassian.net/browse/PROJ-367)");
    expect(prompt).toContain("[PROJ-400](https://example.atlassian.net/browse/PROJ-400)");
    expect(prompt).toContain("include these Jira issue links in the PR description");
    expect(prompt).toContain("create a PR for this");
  });

  it("omits the Jira work-items block when no keys are known", () => {
    const prompt = buildDiscordTurnPrompt({
      mentionPrompt: "hello",
      jiraIssueKeys: [],
      jiraBrowseBaseUrl: "https://example.atlassian.net",
    });
    expect(prompt).not.toContain("Linked work items");
    expect(prompt).not.toContain("Jira issues observed");
  });

  it("injects identity map co-author trailers for starter + requester", () => {
    const prompt = buildDiscordTurnPrompt({
      mentionPrompt: "open a PR",
      starter: {
        id: "starter-1",
        author: { id: "222", username: "davide", displayName: "Davide" },
      },
      requester: {
        id: "mention-1",
        author: {
          id: "95218063095377920",
          username: "patroza",
          displayName: "Patrick Roza",
        },
      },
      identityPeople: [
        {
          name: "Davide",
          discord: { id: "222", username: "davide" },
          github: { login: "davide", id: "99" },
        },
        {
          name: "Patrick Roza",
          discord: { id: "95218063095377920", username: "patroza" },
          github: { login: "patroza", id: "12345" },
        },
      ],
    });

    expect(prompt).toContain("Identity map");
    expect(prompt).toContain("Co-authored-by: Davide <99+davide@users.noreply.github.com>");
    expect(prompt).toContain(
      "Co-authored-by: Patrick Roza <12345+patroza@users.noreply.github.com>",
    );
    expect(prompt).toContain("do not invent emails");
  });

  it("omits identity block when the map is empty/unset", () => {
    const prompt = buildDiscordTurnPrompt({
      mentionPrompt: "hello",
      requester: {
        id: "m1",
        author: { id: "1", username: "x" },
      },
      identityPeople: [],
    });
    expect(prompt).not.toContain("Identity map");
    expect(prompt).not.toContain("Co-authored-by");
  });

  it("injects a ready-to-paste PR footer with profile + channel jump URLs", () => {
    const prompt = buildDiscordTurnPrompt({
      mentionPrompt: "make a pr",
      requester: {
        id: "m1",
        author: { id: "593167616273809448", username: "joshuadima", displayName: "joshuadima" },
      },
      starter: {
        id: "1531376362399465595",
        author: { id: "593167616273809448", username: "joshuadima", displayName: "joshuadima" },
      },
      guildId: "1083767712431480922",
      discordThreadId: "1531376362399465595",
      discordThreadTitle: "Open Random PR Test",
    });
    expect(prompt).toContain("Discord PR description footer");
    expect(prompt).toContain("https://discord.com/users/593167616273809448");
    expect(prompt).toContain(
      "https://discord.com/channels/1083767712431480922/1531376362399465595/1531376362399465595",
    );
    expect(prompt).not.toContain("](593167616273809448)");
    expect(prompt).not.toMatch(/\]\(https:\/\/discord\.com\/channels\)/u);
  });

  it("falls back to bare keys when browse base is unset", () => {
    const block = formatLinkedJiraWorkItemsBlock({
      jiraIssueKeys: ["proj-367"],
      jiraBrowseBaseUrl: undefined,
    });
    expect(block).toContain("`PROJ-367`");
    expect(block).not.toContain("atlassian.net");
  });
});

describe("referenced message + Sentry bootstrap", () => {
  it("treats a Sentry referenced message as investigation context even without starter", () => {
    const referenced = {
      id: "sentry-ref",
      author: { username: "Sentry", bot: true },
      embeds: [
        {
          title: "CarrierErrorWrapped",
          description: "DPDRemoteValidationError",
          url: "https://example.sentry.io/issues/7506163172/",
          fields: [{ name: "environment", value: "prod" }],
          footer: { text: "EXAMPLE-PROJECT-API-JW via Scanner API" },
        },
      ],
    };

    expect(
      looksLikeSentryContext({
        starter: null,
        mentionPrompt: "what would this error mean?",
        referencedMessage: referenced,
      }),
    ).toBe(true);

    const prompt = buildFirstTurnPrompt({
      projectShortName: "example-project",
      workspaceRoot: "/tmp/scanner",
      mentionPrompt: "what would this error mean?",
      mentionMessage: {
        id: "mention-10",
        author: { id: "42", username: "example-user", displayName: "Example User" },
      },
      referencedMessage: referenced,
      referencedMessageUrl: "https://discord.com/channels/g/c/sentry-ref",
      honeycombTraceUrlTemplate:
        "https://ui.eu1.honeycomb.io/example-project/environments/{environment}/trace?trace_id={traceId}",
      starter: null,
    });

    expect(prompt).toContain("Discord investigation bootstrap");
    expect(prompt).toContain("Referenced Discord message");
    expect(prompt).toContain("CarrierErrorWrapped");
    expect(prompt).toContain("EXAMPLE-PROJECT-API-JW");
    expect(prompt).toContain("https://discord.com/channels/g/c/sentry-ref");
  });

  it("formatReferencedMessageBlock labels the reply target", () => {
    const block = formatReferencedMessageBlock({
      message: {
        id: "m1",
        author: { username: "alice" },
        content: "please look at this",
      },
      url: "https://discord.com/channels/1/2/m1",
    });
    expect(block).toContain("## Referenced Discord message");
    expect(block).toContain("please look at this");
    expect(block).toContain("Jump link:");
  });
});
