import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";

import { isJiraProjectAllowed } from "./JiraAppConfig.ts";
import { formatJiraComment } from "./JiraIssueBridge.ts";
import { resolveThreadIdForJiraIssue } from "./JiraThreadLookup.ts";
import {
  bodyMentionsIdentity,
  buildJiraTurnPrompt,
  extractJiraMentionPrompt,
  extractTextAndMentionsFromBody,
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
      actorAccountId: "user-1",
      actorDisplayName: "Ada Lovelace",
      prompt: "investigate the packing failure",
    });
    const prompt = buildJiraTurnPrompt(invocation!);
    expect(prompt).toContain("## Jira issue context");
    expect(prompt).toContain("SA-402");
    expect(prompt).toContain("investigate the packing failure");
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
      prompt: "continue",
    });
  });

  it("ignores bots, self comments, and non-created events", () => {
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
        webhook("@omegent hi", { webhookEvent: "comment_updated" }),
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

  it("bodyMentionsIdentity distinguishes misses", () => {
    expect(bodyMentionsIdentity("hello world", "omegent").matched).toBe(false);
    expect(bodyMentionsIdentity("@omegent please", "omegent").matched).toBe(true);
  });
});
