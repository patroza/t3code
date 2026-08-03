import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";

import {
  isJiraProjectAllowed,
  parseJiraProjectMap,
  resolveMappedT3ProjectId,
  resolveT3ProjectIdForJiraKey,
} from "./JiraAppConfig.ts";
import {
  appendJiraT3ThreadLink,
  buildJiraT3ThreadUrl,
  formatJiraComment,
} from "./JiraIssueBridge.ts";
import { resolveThreadIdForJiraIssue } from "./JiraThreadLookup.ts";
import {
  classifyWebhookBodyFailure,
  previewWebhookBody,
  pruneWebhookDebugRecords,
  type WebhookDebugRecord,
} from "../webhooks/WebhookDebugLog.ts";
import {
  bodyMentionsIdentity,
  buildJiraTurnPrompt,
  extractJiraMentionPrompt,
  extractTextAndMentionsFromBody,
  jiraDeliveryIdFor,
  parseJiraCommentInvocation,
  plainTextToAdf,
  projectKeyFromIssueKey,
  type JiraCommentWebhook,
} from "./JiraWebhookPayload.ts";
import { verifyJiraWebhookSecret } from "./JiraWebhookSecurity.ts";

function webhook(body: unknown, overrides?: Partial<JiraCommentWebhook>): JiraCommentWebhook {
  return {
    webhookEvent: "comment_created",
    timestamp: 1_700_000_000_000,
    comment: {
      id: "10700",
      self: "https://example.atlassian.net/rest/api/3/issue/10001/comment/10700",
      body,
      author: {
        accountId: "user-1",
        displayName: "Ada Lovelace",
        accountType: "atlassian",
      },
    },
    issue: {
      id: "10001",
      key: "SA-402",
      fields: {
        summary: "Packing plan",
        project: { key: "SA" },
      },
    },
    ...overrides,
  };
}

describe("Jira webhook security", () => {
  it("accepts bearer and x-t3-webhook-secret", () => {
    const secret = "development-secret";
    expect(
      verifyJiraWebhookSecret({
        secret,
        authorizationHeader: `Bearer ${secret}`,
        t3SecretHeader: undefined,
        body: "{}",
        signatureHeader: undefined,
      }),
    ).toBe(true);
    expect(
      verifyJiraWebhookSecret({
        secret,
        authorizationHeader: undefined,
        t3SecretHeader: secret,
        body: "{}",
        signatureHeader: undefined,
      }),
    ).toBe(true);
    expect(
      verifyJiraWebhookSecret({
        secret,
        authorizationHeader: "Bearer wrong",
        t3SecretHeader: undefined,
        body: "{}",
        signatureHeader: undefined,
      }),
    ).toBe(false);
  });

  it("accepts optional sha256 body signature", () => {
    const secret = "development-secret";
    const body = JSON.stringify(webhook("@omegent hello"));
    const signature = `sha256=${NodeCrypto.createHmac("sha256", secret).update(body).digest("hex")}`;
    expect(
      verifyJiraWebhookSecret({
        secret,
        authorizationHeader: undefined,
        t3SecretHeader: undefined,
        body,
        signatureHeader: signature,
      }),
    ).toBe(true);
  });
});

describe("Jira mention extraction", () => {
  it("matches plain @handle and returns the prompt", () => {
    expect(extractJiraMentionPrompt("@omegent investigate packing", "omegent")).toBe(
      "investigate packing",
    );
    expect(extractJiraMentionPrompt("please @Omegent fix this", "omegent")).toBe("fix this");
    expect(extractJiraMentionPrompt("no bot here", "omegent")).toBeNull();
    expect(extractJiraMentionPrompt("@omegent", "omegent")).toBeNull();
  });

  it("matches wiki markup mentions", () => {
    expect(extractJiraMentionPrompt("[~omegent] look at SA-402", "omegent")).toBe("look at SA-402");
    expect(extractJiraMentionPrompt("[~accountId:abc-123] please triage", "abc-123")).toBe(
      "please triage",
    );
  });

  it("matches Automation wiki accountId mentions via bot accountId alias", () => {
    const body =
      "[~accountid:712020:187d3a46-cef9-4fcd-881b-b66f1a7e56ab] do you have some ideas what span events could be reduced";
    const botAccountId = "712020:187d3a46-cef9-4fcd-881b-b66f1a7e56ab";
    // Handle alone does not match accountId wiki form.
    expect(extractJiraMentionPrompt(body, "omegent")).toBeNull();
    // Alias (T3CODE_JIRA_BOT_ACCOUNT_ID) matches the picker serialization.
    expect(extractJiraMentionPrompt(body, "omegent", { aliases: [botAccountId] })).toBe(
      "do you have some ideas what span events could be reduced",
    );
    expect(parseJiraCommentInvocation(webhook(body), "omegent", { botAccountId })).toMatchObject({
      issueKey: "SA-402",
      prompt: "do you have some ideas what span events could be reduced",
    });
  });

  it("matches ADF mention nodes by id and text", () => {
    const adf = {
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: { id: "accountid:bot-9", text: "@Omegent", accessLevel: "" },
            },
            { type: "text", text: " summarize this issue" },
          ],
        },
      ],
    };
    expect(extractJiraMentionPrompt(adf, "Omegent")).toBe("summarize this issue");
    expect(extractJiraMentionPrompt(adf, "bot-9")).toBe("summarize this issue");
    expect(extractJiraMentionPrompt(adf, "accountid:bot-9")).toBe("summarize this issue");
  });

  it("extracts text and mention metadata from ADF", () => {
    const extracted = extractTextAndMentionsFromBody({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mention", attrs: { id: "accountid:1", text: "@Bot" } },
            { type: "text", text: " hi" },
          ],
        },
      ],
    });
    expect(extracted.mentionIds).toEqual(["accountid:1"]);
    expect(extracted.mentionTexts).toEqual(["@Bot"]);
    expect(extracted.text).toContain("@Bot");
    expect(extracted.text).toContain("hi");
  });
});

describe("parseJiraCommentInvocation", () => {
  it("parses a plain-text mention into an invocation", () => {
    const invocation = parseJiraCommentInvocation(
      webhook("@omegent investigate the packing failure"),
      "omegent",
    );
    expect(invocation).toMatchObject({
      issueKey: "SA-402",
      projectKey: "SA",
      commentId: "10700",
      replyToCommentId: "10700",
      commentSurface: "issue",
      webhookEvent: "comment_created",
      actorAccountId: "user-1",
      actorDisplayName: "Ada Lovelace",
      prompt: "investigate the packing failure",
    });
    const prompt = buildJiraTurnPrompt(invocation!);
    expect(prompt).toContain("## Jira issue context");
    expect(prompt).toContain("SA-402");
    expect(prompt).toContain("investigate the packing failure");
    expect(jiraDeliveryIdFor({ invocation: invocation! })).toBe("jira-comment:SA-402:10700");
  });

  it("marks threaded parent comments as reply surface", () => {
    const invocation = parseJiraCommentInvocation(
      webhook("@omegent continue", {
        comment: {
          id: "10800",
          body: "@omegent continue",
          parent: { id: "10700" },
          author: { accountId: "user-1", displayName: "Ada", accountType: "atlassian" },
        },
      }),
      "omegent",
    );
    expect(invocation).toMatchObject({
      commentId: "10800",
      replyToCommentId: "10700",
      commentSurface: "reply",
      webhookEvent: "comment_created",
      prompt: "continue",
    });
  });

  it("uses the mention itself as replyTo when the comment is top-level", () => {
    const invocation = parseJiraCommentInvocation(
      webhook("@omegent investigate packing"),
      "omegent",
    );
    expect(invocation).toMatchObject({
      commentId: "10700",
      replyToCommentId: "10700",
      commentSurface: "issue",
    });
  });

  it("parses comment_updated and uses a distinct delivery id per edit", () => {
    const invocation = parseJiraCommentInvocation(
      webhook("@omegent fix the null check properly", {
        webhookEvent: "comment_updated",
        comment: {
          id: "10700",
          body: "@omegent fix the null check properly",
          updated: "2026-07-27T12:00:00.000+0000",
          author: {
            accountId: "user-1",
            displayName: "Ada Lovelace",
            accountType: "atlassian",
          },
        },
      }),
      "omegent",
    );
    expect(invocation).toMatchObject({
      webhookEvent: "comment_updated",
      commentId: "10700",
      commentUpdatedAt: "2026-07-27T12:00:00.000+0000",
      prompt: "fix the null check properly",
    });
    const prompt = buildJiraTurnPrompt(invocation!);
    expect(prompt).toContain("edited");
    expect(prompt).toContain("Updated prompt");
    expect(jiraDeliveryIdFor({ invocation: invocation! })).toBe(
      "jira-comment-updated:SA-402:10700:2026-07-27T120000.0000000",
    );

    const secondEdit = parseJiraCommentInvocation(
      webhook("@omegent actually use Option", {
        webhookEvent: "comment_updated",
        comment: {
          id: "10700",
          body: "@omegent actually use Option",
          updated: "2026-07-27T12:05:00.000+0000",
          author: {
            accountId: "user-1",
            displayName: "Ada Lovelace",
            accountType: "atlassian",
          },
        },
      }),
      "omegent",
    );
    expect(jiraDeliveryIdFor({ invocation: secondEdit! })).not.toBe(
      jiraDeliveryIdFor({ invocation: invocation! }),
    );
  });

  it("ignores bots, self comments, and unrelated events", () => {
    expect(
      parseJiraCommentInvocation(
        webhook("@omegent hi", {
          comment: {
            id: "1",
            body: "@omegent hi",
            author: { accountId: "app-1", accountType: "app" },
          },
        }),
        "omegent",
      ),
    ).toBeNull();

    expect(
      parseJiraCommentInvocation(webhook("@omegent hi"), "omegent", {
        botAccountId: "user-1",
      }),
    ).toBeNull();

    expect(
      parseJiraCommentInvocation(
        webhook("@omegent hi", { webhookEvent: "comment_deleted" }),
        "omegent",
      ),
    ).toBeNull();
  });
});

describe("Jira thread lookup", () => {
  it("resolves a unique active link by issue key", () => {
    const linksJson = JSON.stringify({
      version: 2,
      links: [
        {
          t3ThreadId: "thread-a",
          status: "active",
          jiraIssueKeys: ["SA-402", "SA-409"],
        },
        {
          t3ThreadId: "thread-b",
          status: "tombstone",
          jiraIssueKeys: ["SA-402"],
        },
      ],
    });
    expect(resolveThreadIdForJiraIssue({ issueKey: "SA-402", linksJson })).toEqual({
      _tag: "linked",
      threadId: "thread-a",
    });
  });

  it("reports unlinked and ambiguous cases", () => {
    expect(
      resolveThreadIdForJiraIssue({
        issueKey: "SA-1",
        linksJson: JSON.stringify({ links: [] }),
      }),
    ).toEqual({ _tag: "unlinked" });

    expect(
      resolveThreadIdForJiraIssue({
        issueKey: "SA-1",
        linksJson: JSON.stringify({
          links: [
            { t3ThreadId: "a", status: "active", jiraIssueKeys: ["SA-1"] },
            { t3ThreadId: "b", status: "active", jiraIssueKeys: ["sa-1"] },
          ],
        }),
      }),
    ).toMatchObject({ _tag: "ambiguous" });
  });
});

describe("Jira helpers", () => {
  it("derives project keys and formats comments", () => {
    expect(projectKeyFromIssueKey("sa-402")).toBe("SA");
    expect(isJiraProjectAllowed(new Set(["SA", "CFG"]), "sa")).toBe(true);
    expect(isJiraProjectAllowed(new Set(["SA"]), "CFG")).toBe(false);
    expect(isJiraProjectAllowed(new Set(), "ANY")).toBe(true);
    expect(plainTextToAdf("hello\n\nworld").content).toHaveLength(2);
    expect(formatJiraComment("  ok  ")).toBe("ok");
  });

  it("parses Jira project → T3 project maps", () => {
    const map = parseJiraProjectMap(
      "SA:scanner, CFG=/var/lib/t3/src/macs/configurator , t3:89a7b0dd-cf9c-46da-b2f0-79e19832ac42",
    );
    expect(map.get("SA")).toBe("scanner");
    expect(map.get("CFG")).toBe("/var/lib/t3/src/macs/configurator");
    expect(map.get("T3")).toBe("89a7b0dd-cf9c-46da-b2f0-79e19832ac42");
    expect(parseJiraProjectMap("").size).toBe(0);
    expect(parseJiraProjectMap("nocolon").size).toBe(0);
  });

  it("resolves mapped T3 projects by id, title, basename, and absolute root", () => {
    const projects = [
      {
        id: "5353a657-877e-434b-bc6e-b79e0d003848",
        title: "scanner",
        workspaceRoot: "/var/lib/t3/src/macs/scanner",
      },
      {
        id: "4691a389-ecd7-4495-9dde-b8da07ce229f",
        title: "configurator",
        workspaceRoot: "/var/lib/t3/src/macs/configurator/",
      },
    ] as const;

    expect(resolveMappedT3ProjectId("5353a657-877e-434b-bc6e-b79e0d003848", projects)).toBe(
      "5353a657-877e-434b-bc6e-b79e0d003848",
    );
    expect(resolveMappedT3ProjectId("Scanner", projects)).toBe(
      "5353a657-877e-434b-bc6e-b79e0d003848",
    );
    expect(resolveMappedT3ProjectId("scanner", projects)).toBe(
      "5353a657-877e-434b-bc6e-b79e0d003848",
    );
    expect(resolveMappedT3ProjectId("/var/lib/t3/src/macs/scanner", projects)).toBe(
      "5353a657-877e-434b-bc6e-b79e0d003848",
    );
    expect(resolveMappedT3ProjectId("/var/lib/t3/src/macs/configurator", projects)).toBe(
      "4691a389-ecd7-4495-9dde-b8da07ce229f",
    );
    // Full path that is not an exact workspace root must not basename-fall-through.
    expect(resolveMappedT3ProjectId("/other/src/scanner", projects)).toBeNull();
    expect(resolveMappedT3ProjectId("missing", projects)).toBeNull();

    const map = parseJiraProjectMap("SA:/var/lib/t3/src/macs/scanner,CFG:configurator");
    expect(resolveT3ProjectIdForJiraKey(map, "sa", projects)).toBe(
      "5353a657-877e-434b-bc6e-b79e0d003848",
    );
    expect(resolveT3ProjectIdForJiraKey(map, "CFG", projects)).toBe(
      "4691a389-ecd7-4495-9dde-b8da07ce229f",
    );
    expect(resolveT3ProjectIdForJiraKey(map, "OTHER", projects)).toBeNull();
  });

  it("builds and appends a hosted T3 thread link for Jira replies", () => {
    const url = buildJiraT3ThreadUrl({
      hostedAppUrl: "https://nightly.app.t3.codes",
      environmentId: "env-1",
      threadId: "thread-1",
    });
    expect(url).toBe("https://nightly.app.t3.codes/threads/env-1/thread-1");
    expect(
      appendJiraT3ThreadLink("Ship it.", {
        hostedAppUrl: "https://nightly.app.t3.codes",
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toBe("Ship it.\n\nT3 thread: https://nightly.app.t3.codes/threads/env-1/thread-1");
  });

  it("does not duplicate the Jira T3 thread link footer", () => {
    const body = "Ship it.\n\nT3 thread: https://nightly.app.t3.codes/threads/env-1/thread-1";
    expect(
      appendJiraT3ThreadLink(body, {
        hostedAppUrl: "https://nightly.app.t3.codes",
        environmentId: "env-1",
        threadId: "thread-1",
      }),
    ).toBe(body);
  });

  it("bodyMentionsIdentity distinguishes misses", () => {
    expect(bodyMentionsIdentity("hello world", "omegent").matched).toBe(false);
    expect(bodyMentionsIdentity("@omegent please", "omegent").matched).toBe(true);
    expect(
      bodyMentionsIdentity(
        "[~accountid:712020:187d3a46-cef9-4fcd-881b-b66f1a7e56ab] hi",
        "omegent",
        { aliases: ["712020:187d3a46-cef9-4fcd-881b-b66f1a7e56ab"] },
      ),
    ).toMatchObject({
      matched: true,
      matchedAs: "712020:187d3a46-cef9-4fcd-881b-b66f1a7e56ab",
    });
  });
});

describe("Webhook debug log helpers", () => {
  it("classifies empty, broken JSON, and schema-shaped failures", () => {
    expect(classifyWebhookBodyFailure("").reason).toBe("empty_body");
    expect(classifyWebhookBodyFailure("  ").reason).toBe("empty_body");

    const broken = '{\n  "comment": {\n    "body": "line1\nline2"\n  }\n}';
    const brokenResult = classifyWebhookBodyFailure(broken);
    expect(brokenResult.reason).toBe("json_parse_failed");
    expect(brokenResult.detail?.length).toBeGreaterThan(0);

    const validJsonWrongShape = JSON.stringify({ hello: "world" });
    expect(classifyWebhookBodyFailure(validJsonWrongShape).reason).toBe("schema_decode_failed");
  });

  it("previews bodies with a byte count and truncation", () => {
    const short = previewWebhookBody("abc");
    expect(short.bodyBytes).toBe(3);
    expect(short.bodyPreview).toBe("abc");

    const long = previewWebhookBody("x".repeat(50), 10);
    expect(long.bodyBytes).toBe(50);
    expect(long.bodyPreview).toBe(`${"x".repeat(10)}…`);
  });

  it("prunes records older than max age and applies a hard cap", () => {
    const now = Date.parse("2026-07-29T14:00:00.000Z");
    const records: WebhookDebugRecord[] = [
      {
        ts: "2026-07-28T13:00:00.000Z",
        source: "jira",
        outcome: "invalid_400",
        status: 400,
        bodyBytes: 1,
      },
      {
        ts: "2026-07-29T12:00:00.000Z",
        source: "github",
        outcome: "accepted_202",
        status: 202,
        bodyBytes: 2,
      },
      {
        ts: "2026-07-29T13:30:00.000Z",
        source: "jira",
        outcome: "ignored_202",
        status: 202,
        bodyBytes: 3,
      },
    ];

    const pruned = pruneWebhookDebugRecords(records, now, 24 * 60 * 60 * 1000);
    expect(pruned.map((r) => r.outcome)).toEqual(["accepted_202", "ignored_202"]);

    const capped = pruneWebhookDebugRecords(records, now, 48 * 60 * 60 * 1000, 1);
    expect(capped).toHaveLength(1);
    expect(capped[0]?.outcome).toBe("ignored_202");
  });
});
