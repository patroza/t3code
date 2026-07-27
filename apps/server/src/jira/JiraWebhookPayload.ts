import * as Schema from "effect/Schema";

const NonEmpty = Schema.String.check(Schema.isNonEmpty());

/** Minimal Jira Cloud user object on webhook payloads. */
export const JiraWebhookUser = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  emailAddress: Schema.optional(Schema.String),
  active: Schema.optional(Schema.Boolean),
  accountType: Schema.optional(Schema.String),
});
export type JiraWebhookUser = typeof JiraWebhookUser.Type;

/**
 * Jira Cloud `comment_created` / `comment_updated` payload (subset).
 * `comment.body` may be a plain string (legacy) or ADF document (Cloud API v3).
 */
export const JiraCommentWebhook = Schema.Struct({
  timestamp: Schema.optional(Schema.Number),
  webhookEvent: Schema.optional(Schema.String),
  comment: Schema.Struct({
    id: Schema.Union([Schema.String, Schema.Number]),
    self: Schema.optional(Schema.String),
    body: Schema.Unknown,
    author: Schema.optional(JiraWebhookUser),
    updateAuthor: Schema.optional(JiraWebhookUser),
    created: Schema.optional(Schema.String),
    updated: Schema.optional(Schema.String),
    /**
     * Present when the comment is a reply in a threaded discussion (when Jira provides it).
     * String or number depending on payload shape.
     */
    parent: Schema.optional(
      Schema.Union([
        Schema.Struct({ id: Schema.Union([Schema.String, Schema.Number]) }),
        Schema.String,
        Schema.Number,
      ]),
    ),
    jsdPublic: Schema.optional(Schema.Boolean),
  }),
  issue: Schema.Struct({
    id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
    self: Schema.optional(Schema.String),
    key: NonEmpty,
    fields: Schema.optional(
      Schema.Struct({
        summary: Schema.optional(Schema.String),
        project: Schema.optional(
          Schema.Struct({
            key: Schema.optional(Schema.String),
            id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
          }),
        ),
      }),
    ),
  }),
});
export type JiraCommentWebhook = typeof JiraCommentWebhook.Type;

export type JiraCommentSurface = "issue" | "reply";

/** Inbound comment webhook events we accept. */
export type JiraCommentWebhookEvent = "comment_created" | "comment_updated";

const ACCEPTED_COMMENT_EVENTS = new Set<string>(["comment_created", "comment_updated"]);

export function isAcceptedJiraCommentEvent(
  event: string | undefined,
): event is JiraCommentWebhookEvent {
  if (event === undefined) return true; // Automation may omit; treat as created-style delivery
  return ACCEPTED_COMMENT_EVENTS.has(event.trim().toLowerCase());
}

export function normalizeJiraCommentEvent(event: string | undefined): JiraCommentWebhookEvent {
  const normalized = event?.trim().toLowerCase();
  if (normalized === "comment_updated") return "comment_updated";
  return "comment_created";
}

export interface JiraIssueInvocation {
  readonly issueKey: string;
  readonly issueSummary: string | null;
  readonly projectKey: string;
  readonly commentId: string;
  readonly commentUrl: string | null;
  /** Parent comment id when this is a threaded reply; otherwise equals `commentId`. */
  readonly replyToCommentId: string;
  readonly commentSurface: JiraCommentSurface;
  /** `comment_created` or `comment_updated` (edits re-dispatch with a new delivery id). */
  readonly webhookEvent: JiraCommentWebhookEvent;
  /** Comment `updated` timestamp when present (used for update delivery dedupe). */
  readonly commentUpdatedAt: string | null;
  readonly actorAccountId: string | null;
  readonly actorDisplayName: string | null;
  readonly prompt: string;
  /** Raw plain-text extraction of the comment (for logs / secondary matching). */
  readonly commentText: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function asStringId(value: string | number | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

/** Recursively collect text and mention nodes from ADF or plain strings. */
export function extractTextAndMentionsFromBody(body: unknown): {
  readonly text: string;
  readonly mentionIds: ReadonlyArray<string>;
  readonly mentionTexts: ReadonlyArray<string>;
} {
  const textParts: string[] = [];
  const mentionIds: string[] = [];
  const mentionTexts: string[] = [];
  const seenIds = new Set<string>();
  const seenTexts = new Set<string>();

  const visit = (node: unknown): void => {
    if (node === null || node === undefined) return;
    if (typeof node === "string") {
      textParts.push(node);
      return;
    }
    if (typeof node !== "object") return;
    const record = node as Record<string, unknown>;

    if (record.type === "mention" && record.attrs && typeof record.attrs === "object") {
      const attrs = record.attrs as Record<string, unknown>;
      const id = typeof attrs.id === "string" ? attrs.id.trim() : "";
      const text = typeof attrs.text === "string" ? attrs.text.trim() : "";
      if (id.length > 0 && !seenIds.has(id)) {
        seenIds.add(id);
        mentionIds.push(id);
      }
      if (text.length > 0 && !seenTexts.has(text)) {
        seenTexts.add(text);
        mentionTexts.push(text);
      }
      if (text.length > 0) textParts.push(text);
      return;
    }

    if (typeof record.text === "string") {
      textParts.push(record.text);
    }
    if (Array.isArray(record.content)) {
      for (const child of record.content) visit(child);
    }
  };

  if (typeof body === "string") {
    textParts.push(body);
  } else {
    visit(body);
  }

  return {
    text: textParts.join("").replace(/\s+/gu, " ").trim(),
    mentionIds,
    mentionTexts,
  };
}

/**
 * True when the comment body addresses `mention` via plain @handle, wiki markup, or ADF mention.
 * `mention` may be a handle without @, a display name, or an accountId (with or without `accountid:`).
 */
export function bodyMentionsIdentity(
  body: unknown,
  mention: string,
): { readonly matched: boolean; readonly text: string } {
  const normalized = mention.trim().replace(/^@/u, "");
  if (normalized.length === 0) return { matched: false, text: "" };

  const extracted = extractTextAndMentionsFromBody(body);
  const text = extracted.text;
  const lowerMention = normalized.toLowerCase();
  const mentionAccountId = lowerMention.startsWith("accountid:")
    ? lowerMention
    : `accountid:${lowerMention}`;

  for (const id of extracted.mentionIds) {
    const lower = id.toLowerCase();
    if (
      lower === lowerMention ||
      lower === mentionAccountId ||
      lower.endsWith(`:${lowerMention}`)
    ) {
      return { matched: true, text };
    }
  }
  for (const mentionText of extracted.mentionTexts) {
    const stripped = mentionText.replace(/^@/u, "").trim().toLowerCase();
    if (stripped === lowerMention) return { matched: true, text };
  }

  // Plain @handle (word-ish boundary)
  const atMatcher = new RegExp(`(?:^|\\s)@${escapeRegExp(normalized)}(?:\\s+|$)`, "iu");
  if (atMatcher.test(text)) return { matched: true, text };

  // Wiki / legacy: [~accountId:…] or [~username]
  const wikiMatcher = new RegExp(`\\[~(?:accountId:)?${escapeRegExp(normalized)}\\]`, "iu");
  if (wikiMatcher.test(text)) return { matched: true, text };

  return { matched: false, text };
}

/** Strip the first matching mention token and return the remaining prompt, or null. */
export function extractJiraMentionPrompt(body: unknown, mention: string): string | null {
  const normalized = mention.trim().replace(/^@/u, "");
  if (normalized.length === 0) return null;

  const { matched, text } = bodyMentionsIdentity(body, normalized);
  if (!matched) return null;

  // Prefer stripping @handle form from plain text.
  const atMatcher = new RegExp(`(?:^|\\s)@${escapeRegExp(normalized)}(?:\\s+|$)`, "iu");
  const atMatch = atMatcher.exec(text);
  if (atMatch) {
    const prompt = text.slice(atMatch.index + atMatch[0].length).trim();
    return prompt.length > 0 ? prompt : null;
  }

  const wikiMatcher = new RegExp(`\\[~(?:accountId:)?${escapeRegExp(normalized)}\\]\\s*`, "iu");
  const wikiMatch = wikiMatcher.exec(text);
  if (wikiMatch) {
    const prompt =
      `${text.slice(0, wikiMatch.index)}${text.slice(wikiMatch.index + wikiMatch[0].length)}`
        .replace(/\s+/gu, " ")
        .trim();
    return prompt.length > 0 ? prompt : null;
  }

  // ADF mention: strip leading @DisplayName if present, else whole text after first mention token.
  const mentionTextMatcher = new RegExp(`(?:^|\\s)@${escapeRegExp(normalized)}\\b`, "iu");
  const mentionTextMatch = mentionTextMatcher.exec(text);
  if (mentionTextMatch) {
    const prompt = text.slice(mentionTextMatch.index + mentionTextMatch[0].length).trim();
    return prompt.length > 0 ? prompt : null;
  }

  // Mention matched only via ADF attrs.id — use full text as prompt when non-empty.
  const cleaned = text.replace(/^@\S+\s*/u, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function projectKeyFromIssueKey(issueKey: string): string {
  const match = /^([A-Z][A-Z0-9_]+)-\d+$/u.exec(issueKey.trim().toUpperCase());
  return match?.[1] ?? issueKey.split("-")[0]?.toUpperCase() ?? "";
}

function parentCommentId(parent: JiraCommentWebhook["comment"]["parent"]): string | null {
  if (parent === undefined || parent === null) return null;
  if (typeof parent === "string" || typeof parent === "number") {
    return asStringId(parent);
  }
  return asStringId(parent.id);
}

function isBotAuthor(author: JiraWebhookUser | undefined): boolean {
  if (!author) return false;
  const accountType = author.accountType?.toLowerCase();
  if (accountType === "app" || accountType === "bot") return true;
  return false;
}

export function parseJiraCommentInvocation(
  payload: JiraCommentWebhook,
  mention: string,
  options?: {
    /** Skip comments authored by this accountId (the bot itself). */
    readonly botAccountId?: string | null;
  },
): JiraIssueInvocation | null {
  if (!isAcceptedJiraCommentEvent(payload.webhookEvent)) return null;
  if (isBotAuthor(payload.comment.author)) return null;

  const authorAccountId = payload.comment.author?.accountId?.trim() || null;
  const botAccountId = options?.botAccountId?.trim() || null;
  if (
    botAccountId !== null &&
    authorAccountId !== null &&
    authorAccountId.toLowerCase() === botAccountId.toLowerCase()
  ) {
    return null;
  }

  const prompt = extractJiraMentionPrompt(payload.comment.body, mention);
  if (prompt === null) return null;

  const issueKey = payload.issue.key.trim().toUpperCase();
  const commentId = asStringId(payload.comment.id);
  if (commentId === null) return null;

  const parentId = parentCommentId(payload.comment.parent);
  const replyToCommentId = parentId ?? commentId;
  const commentSurface: JiraCommentSurface = parentId !== null ? "reply" : "issue";
  const projectKey =
    payload.issue.fields?.project?.key?.trim().toUpperCase() || projectKeyFromIssueKey(issueKey);

  const extracted = extractTextAndMentionsFromBody(payload.comment.body);
  const commentSelf = payload.comment.self?.trim() || null;
  const webhookEvent = normalizeJiraCommentEvent(payload.webhookEvent);
  const commentUpdatedAt = payload.comment.updated?.trim() || null;

  return {
    issueKey,
    issueSummary: payload.issue.fields?.summary?.trim() || null,
    projectKey,
    commentId,
    commentUrl: commentSelf,
    replyToCommentId,
    commentSurface,
    webhookEvent,
    commentUpdatedAt,
    actorAccountId: authorAccountId,
    actorDisplayName: payload.comment.author?.displayName?.trim() || null,
    prompt,
    commentText: extracted.text,
  };
}

export function buildJiraTurnPrompt(invocation: JiraIssueInvocation): string {
  const requester = invocation.actorDisplayName ?? invocation.actorAccountId ?? "unknown";
  const isUpdate = invocation.webhookEvent === "comment_updated";
  const lines = [
    "<!--",
    "## Jira issue context",
    `- Issue: ${invocation.issueKey}${invocation.issueSummary ? ` — ${invocation.issueSummary}` : ""}`,
    `- Project: ${invocation.projectKey}`,
    `- Comment surface: ${invocation.commentSurface}`,
    `- Webhook event: ${invocation.webhookEvent}`,
    `- Comment id: ${invocation.commentId}`,
    `- Reply-to comment id: ${invocation.replyToCommentId}`,
    invocation.commentUpdatedAt ? `- Comment updated at: ${invocation.commentUpdatedAt}` : null,
    `- Jira requester: ${requester}${invocation.actorAccountId ? ` (accountId ${invocation.actorAccountId})` : ""}`,
    invocation.commentUrl ? `- Comment: ${invocation.commentUrl}` : null,
    "-->",
    "",
    isUpdate
      ? [
          "The Jira user **edited** an earlier comment that addresses the bot. Treat the updated prompt as authoritative and discard work that only applied to a previous version of this comment.",
          "",
          `Updated prompt from Jira [${requester}] on [${invocation.issueKey}]${invocation.commentUrl ? `(${invocation.commentUrl})` : ""}: ${invocation.prompt}`,
        ].join("\n")
      : `From Jira [${requester}] on [${invocation.issueKey}]${invocation.commentUrl ? `(${invocation.commentUrl})` : ""}: ${invocation.prompt}`,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

/**
 * Stable delivery id: creates dedupe on comment id; updates include updated-at / prompt
 * so redeliveries of the same edit collapse but new edits re-run.
 */
export function jiraDeliveryIdFor(input: {
  readonly invocation: JiraIssueInvocation;
  readonly headerDeliveryId?: string | undefined;
}): string {
  if (input.headerDeliveryId && input.headerDeliveryId.trim().length > 0) {
    return input.headerDeliveryId.trim();
  }
  const { invocation } = input;
  if (invocation.webhookEvent === "comment_updated") {
    const stamp =
      invocation.commentUpdatedAt?.replace(/[^0-9A-Za-z._-]/gu, "") ||
      // Fall back to a short hash of the prompt so body-only edits without `updated` still re-run.
      simplePromptFingerprint(invocation.prompt);
    return `jira-comment-updated:${invocation.issueKey}:${invocation.commentId}:${stamp}`;
  }
  return `jira-comment:${invocation.issueKey}:${invocation.commentId}`;
}

function simplePromptFingerprint(prompt: string): string {
  // FNV-1a 32-bit — stable, no crypto dependency, good enough for delivery keys.
  let hash = 0x811c9dc5;
  const normalized = prompt.replace(/\s+/gu, " ").trim();
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Minimal ADF document from plain text paragraphs (API v3 comment body). */
export function plainTextToAdf(text: string): {
  readonly type: "doc";
  readonly version: 1;
  readonly content: ReadonlyArray<{
    readonly type: "paragraph";
    readonly content: ReadonlyArray<{ readonly type: "text"; readonly text: string }>;
  }>;
} {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const blocks = paragraphs.length > 0 ? paragraphs : [text.trim() || " "];
  return {
    type: "doc",
    version: 1,
    content: blocks.map((block) => ({
      type: "paragraph" as const,
      content: [{ type: "text" as const, text: block }],
    })),
  };
}
