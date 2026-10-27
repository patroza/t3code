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
     * String or number depending on payload shape. Empty `id` (Automation blank fields)
     * is treated as missing by `parentCommentIdFromPayload`.
     */
    parent: Schema.optional(
      Schema.Union([
        Schema.Struct({
          id: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
        }),
        Schema.String,
        Schema.Number,
        Schema.Null,
      ]),
    ),
    /**
     * REST list/get shape uses top-level `parentId` (number|string|null). Accept it on
     * webhooks/Automation so nested mentions resolve without an extra GET when present.
     */
    parentId: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
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

export type JiraCommentSurface = "issue" | "reply" | "assignment";

/** Inbound comment webhook events we accept. */
export type JiraCommentWebhookEvent = "comment_created" | "comment_updated";

/** Comment events plus assignment of the configured bot. */
export type JiraInboundWebhookEvent = JiraCommentWebhookEvent | "issue_assigned";

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
  /** `comment_created`, `comment_updated`, or `issue_assigned`. */
  readonly webhookEvent: JiraInboundWebhookEvent;
  /**
   * Comment `updated` timestamp, or the assignment stamp (changelog id, else
   * issue `updated`, else webhook timestamp). Used for delivery dedupe.
   */
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

/** Normalize a mention handle / display name / accountId for comparison. */
function normalizeMentionToken(mention: string): string {
  return mention.trim().replace(/^@/u, "");
}

/**
 * Primary mention plus optional aliases (e.g. bot accountId for wiki/ADF picker mentions).
 * Order is preserved; duplicates (case-insensitive) are dropped.
 */
export function jiraMentionCandidates(
  mention: string,
  aliases: ReadonlyArray<string | null | undefined> = [],
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [mention, ...aliases]) {
    if (raw === null || raw === undefined) continue;
    const normalized = normalizeMentionToken(raw);
    if (normalized.length === 0) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function bodyMentionsSingleIdentity(
  extracted: ReturnType<typeof extractTextAndMentionsFromBody>,
  normalized: string,
): boolean {
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
      return true;
    }
  }
  for (const mentionText of extracted.mentionTexts) {
    const stripped = mentionText.replace(/^@/u, "").trim().toLowerCase();
    if (stripped === lowerMention) return true;
  }

  // Plain @handle (word-ish boundary)
  const atMatcher = new RegExp(`(?:^|\\s)@${escapeRegExp(normalized)}(?:\\s+|$)`, "iu");
  if (atMatcher.test(text)) return true;

  // Wiki / legacy: [~accountId:…] or [~username]
  // Automation often serializes Cloud mentions as [~accountid:712020:…].
  const wikiMatcher = new RegExp(`\\[~(?:accountId:)?${escapeRegExp(normalized)}\\]`, "iu");
  if (wikiMatcher.test(text)) return true;

  return false;
}

/**
 * True when the comment body addresses `mention` via plain @handle, wiki markup, or ADF mention.
 * `mention` may be a handle without @, a display name, or an accountId (with or without `accountid:`).
 * `aliases` are alternate identities (typically `T3CODE_JIRA_BOT_ACCOUNT_ID`) for wiki/ADF picker form.
 */
export function bodyMentionsIdentity(
  body: unknown,
  mention: string,
  options?: {
    readonly aliases?: ReadonlyArray<string | null | undefined>;
  },
): { readonly matched: boolean; readonly text: string; readonly matchedAs: string | null } {
  const extracted = extractTextAndMentionsFromBody(body);
  const text = extracted.text;
  const candidates = jiraMentionCandidates(mention, options?.aliases ?? []);
  if (candidates.length === 0) return { matched: false, text, matchedAs: null };

  for (const candidate of candidates) {
    if (bodyMentionsSingleIdentity(extracted, candidate)) {
      return { matched: true, text, matchedAs: candidate };
    }
  }
  return { matched: false, text, matchedAs: null };
}

/** Strip the first matching mention token and return the remaining prompt, or null. */
export function extractJiraMentionPrompt(
  body: unknown,
  mention: string,
  options?: {
    readonly aliases?: ReadonlyArray<string | null | undefined>;
  },
): string | null {
  const { matched, text, matchedAs } = bodyMentionsIdentity(body, mention, options);
  if (!matched || matchedAs === null) return null;

  // Prefer stripping @handle form from plain text (try all candidates so @omegent still strips
  // when the match was via accountId wiki markup).
  for (const candidate of jiraMentionCandidates(mention, options?.aliases ?? [])) {
    const atMatcher = new RegExp(`(?:^|\\s)@${escapeRegExp(candidate)}(?:\\s+|$)`, "iu");
    const atMatch = atMatcher.exec(text);
    if (atMatch) {
      const prompt = text.slice(atMatch.index + atMatch[0].length).trim();
      return prompt.length > 0 ? prompt : null;
    }
  }

  for (const candidate of jiraMentionCandidates(mention, options?.aliases ?? [])) {
    const wikiMatcher = new RegExp(`\\[~(?:accountId:)?${escapeRegExp(candidate)}\\]\\s*`, "iu");
    const wikiMatch = wikiMatcher.exec(text);
    if (wikiMatch) {
      const prompt =
        `${text.slice(0, wikiMatch.index)}${text.slice(wikiMatch.index + wikiMatch[0].length)}`
          .replace(/\s+/gu, " ")
          .trim();
      return prompt.length > 0 ? prompt : null;
    }
  }

  // ADF mention: strip leading @DisplayName if present, else whole text after first mention token.
  for (const candidate of jiraMentionCandidates(mention, options?.aliases ?? [])) {
    const mentionTextMatcher = new RegExp(`(?:^|\\s)@${escapeRegExp(candidate)}\\b`, "iu");
    const mentionTextMatch = mentionTextMatcher.exec(text);
    if (mentionTextMatch) {
      const prompt = text.slice(mentionTextMatch.index + mentionTextMatch[0].length).trim();
      return prompt.length > 0 ? prompt : null;
    }
  }

  // Mention matched only via ADF attrs.id — use full text as prompt when non-empty.
  const cleaned = text.replace(/^@\S+\s*/u, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export function projectKeyFromIssueKey(issueKey: string): string {
  const match = /^([A-Z][A-Z0-9_]+)-\d+$/u.exec(issueKey.trim().toUpperCase());
  return match?.[1] ?? issueKey.split("-")[0]?.toUpperCase() ?? "";
}

function parentCommentIdFromPayload(comment: JiraCommentWebhook["comment"]): string | null {
  // Prefer REST-style parentId (what GET /comment returns and Automation can mirror).
  const fromParentId = asStringId(comment.parentId ?? null);
  if (fromParentId !== null) return fromParentId;

  const parent = comment.parent;
  if (parent === undefined || parent === null) return null;
  if (typeof parent === "string" || typeof parent === "number") {
    return asStringId(parent);
  }
  return asStringId(parent.id ?? null);
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

  // Match handle (T3CODE_JIRA_MENTION) and bot accountId (picker/wiki [~accountid:…]).
  const prompt = extractJiraMentionPrompt(payload.comment.body, mention, {
    aliases: botAccountId !== null ? [botAccountId] : [],
  });
  if (prompt === null) return null;

  const issueKey = payload.issue.key.trim().toUpperCase();
  const commentId = asStringId(payload.comment.id);
  if (commentId === null) return null;

  const parentId = parentCommentIdFromPayload(payload.comment);
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

function jiraPromptHeaderLines(invocation: JiraIssueInvocation): Array<string | null> {
  const requester = invocation.actorDisplayName ?? invocation.actorAccountId ?? "unknown";
  return [
    "<!--",
    "## Jira issue context",
    `- Issue: ${invocation.issueKey}${invocation.issueSummary ? `: ${invocation.issueSummary}` : ""}`,
    `- Project: ${invocation.projectKey}`,
    `- Comment surface: ${invocation.commentSurface}`,
    `- Webhook event: ${invocation.webhookEvent}`,
    `- Comment id: ${invocation.commentId}`,
    `- Reply-to comment id: ${invocation.replyToCommentId}`,
    invocation.commentUpdatedAt ? `- Comment updated at: ${invocation.commentUpdatedAt}` : null,
    `- Jira requester: ${requester}${invocation.actorAccountId ? ` (accountId ${invocation.actorAccountId})` : ""}`,
    invocation.commentUrl ? `- Comment: ${invocation.commentUrl}` : null,
  ];
}

const JIRA_COMMENT_LINK_RULE =
  "In any Jira comment, write each URL as a markdown link with a short label, for example [scanner#2458](https://github.com/macs-holding/scanner/pull/2458). A bare URL stays plain text.";

export function buildJiraTurnPrompt(invocation: JiraIssueInvocation): string {
  const requester = invocation.actorDisplayName ?? invocation.actorAccountId ?? "unknown";
  const isUpdate = invocation.webhookEvent === "comment_updated";
  const isAssignment = invocation.webhookEvent === "issue_assigned";
  const issueRef = `[${invocation.issueKey}]${invocation.commentUrl ? `(${invocation.commentUrl})` : ""}`;
  const lines = [
    ...jiraPromptHeaderLines(invocation),
    "-->",
    "",
    JIRA_COMMENT_LINK_RULE,
    "",
    isAssignment
      ? `Assigned by Jira [${requester}] on ${issueRef}.\n\n${invocation.prompt}`
      : isUpdate
        ? [
            "The Jira user **edited** an earlier comment that addresses the bot. Treat the updated prompt as authoritative and discard work that only applied to a previous version of this comment.",
            "",
            `Updated prompt from Jira [${requester}] on ${issueRef}: ${invocation.prompt}`,
          ].join("\n")
        : `From Jira [${requester}] on ${issueRef}: ${invocation.prompt}`,
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
  const { invocation } = input;
  // Assignment retries share a changelog id. A webhook registration id is stable
  // across events, so it must not collapse later assignments into the first one.
  if (invocation.webhookEvent === "issue_assigned") {
    const stamp = invocation.commentUpdatedAt?.replace(/[^0-9A-Za-z._-]/gu, "") || "assign";
    return `jira-assign:${invocation.issueKey}:${stamp}`;
  }
  if (input.headerDeliveryId && input.headerDeliveryId.trim().length > 0) {
    return input.headerDeliveryId.trim();
  }
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

const ASSIGNMENT_TASK =
  "You were assigned this Jira issue. Analyze it and propose a fix or implementation. Read the description, comments, and linked work before answering. When the change is clear and scoped to this issue, implement it on this thread. When it is ambiguous, reply with a concrete plan and the open questions.";

const ASSIGNMENT_DESCRIPTION_LIMIT = 4_000;

export type JiraAssignmentParse =
  | { readonly _tag: "not_assignment" }
  | { readonly _tag: "ignored"; readonly reason: string }
  | { readonly _tag: "invocation"; readonly invocation: JiraIssueInvocation };

type AssigneeIdentity = {
  readonly accountId: string | null;
  readonly displayName: string | null;
};

function normalizedEventName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  return text.length > 0 ? text : null;
}

function normalizeIdentity(value: string): string {
  return value
    .trim()
    .replace(/^@/u, "")
    .replace(/^accountid:/iu, "")
    .toLowerCase();
}

function identityMatches(
  candidate: string | null,
  mention: string,
  botAccountId: string | null,
): boolean {
  if (candidate === null) return false;
  const normalized = normalizeIdentity(candidate);
  if (normalized.length === 0) return false;
  const targets = [mention, botAccountId].flatMap((value) => {
    if (value === null || value.trim().length === 0) return [];
    const normalizedTarget = normalizeIdentity(value);
    return normalizedTarget.length > 0 ? [normalizedTarget] : [];
  });
  return targets.some((target) => target === normalized);
}

function readRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function ownString(record: Record<string, unknown>, key: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return null;
  const value = record[key];
  if (typeof value !== "string" && typeof value !== "number") return null;
  return asStringId(value);
}

function readAssigneeIdentity(value: unknown): AssigneeIdentity | null {
  const record = readRecord(value);
  if (record === null) return null;
  const field = normalizedEventName(ownString(record, "field"));
  const fieldId = normalizedEventName(ownString(record, "fieldId"));
  // Changelog items name the field. Issue `fields.assignee` does not.
  if (field !== null || fieldId !== null) {
    if (field !== "assignee" && fieldId !== "assignee") return null;
  }
  return {
    accountId:
      ownString(record, "to") ??
      ownString(record, "tmpToAccountId") ??
      ownString(record, "accountId"),
    displayName: ownString(record, "toString") ?? ownString(record, "displayName"),
  };
}

function changelogAssigneeChanges(payload: Record<string, unknown>): AssigneeIdentity[] {
  const changelog = readRecord(payload.changelog);
  const items = changelog?.items;
  if (!Array.isArray(items)) return [];
  const changes: AssigneeIdentity[] = [];
  for (const item of items) {
    const record = readRecord(item);
    if (record === null) continue;
    const field = normalizedEventName(record.field);
    const fieldId = normalizedEventName(record.fieldId);
    if (field !== "assignee" && fieldId !== "assignee") continue;
    const identity = readAssigneeIdentity(record);
    if (identity !== null) changes.push(identity);
  }
  return changes;
}

function assigneeFromIssue(payload: Record<string, unknown>): AssigneeIdentity | null {
  const issue = readRecord(payload.issue);
  const fields = readRecord(issue?.fields);
  if (fields === null || !("assignee" in fields)) return null;
  if (fields.assignee === null) return { accountId: null, displayName: null };
  return readAssigneeIdentity(fields.assignee);
}

function readActor(payload: Record<string, unknown>): {
  readonly accountId: string | null;
  readonly displayName: string | null;
} {
  const user = readRecord(payload.user) ?? readRecord(payload.actor);
  return {
    accountId: asStringId(user?.accountId as string | number | null | undefined),
    displayName: asStringId(user?.displayName as string | number | null | undefined),
  };
}

function assignmentStamp(
  payload: Record<string, unknown>,
  assignee: AssigneeIdentity,
): string | null {
  const changelog = readRecord(payload.changelog);
  const changelogId = asStringId(changelog?.id as string | number | null | undefined);
  if (changelogId !== null) return changelogId;
  const issue = readRecord(payload.issue);
  const fields = readRecord(issue?.fields);
  const updated = asStringId(fields?.updated as string | number | null | undefined);
  if (updated !== null) return updated;
  const timestamp = asStringId(payload.timestamp as string | number | null | undefined);
  if (timestamp !== null) return timestamp;
  return assignee.accountId ?? assignee.displayName;
}

function assignmentPrompt(summary: string | null, description: unknown): string {
  const lines = [ASSIGNMENT_TASK];
  if (summary !== null && summary.length > 0) {
    lines.push("", `Summary: ${summary}`);
  }
  const descriptionText = extractTextAndMentionsFromBody(description).text.trim();
  if (descriptionText.length > 0) {
    const clipped =
      descriptionText.length > ASSIGNMENT_DESCRIPTION_LIMIT
        ? `${descriptionText.slice(0, ASSIGNMENT_DESCRIPTION_LIMIT)}…`
        : descriptionText;
    lines.push("", "Description:", clipped);
  }
  return lines.join("\n");
}

// Comment payloads remain owned by the comment parser.
// Issue updates require an assignee changelog change to the bot; explicit assignment events may omit changelog.
export function parseJiraAssignmentInvocation(
  payload: unknown,
  mention: string,
  options?: {
    readonly botAccountId?: string | null;
  },
): JiraAssignmentParse {
  const record = readRecord(payload);
  if (record === null) return { _tag: "not_assignment" };

  const event = normalizedEventName(record.webhookEvent);
  if (event !== null && event.startsWith("comment")) {
    return { _tag: "not_assignment" };
  }

  const issueEvent = normalizedEventName(record.issue_event_type_name);
  const explicitAssign =
    event === "issue_assigned" ||
    event === "jira:issue_assigned" ||
    issueEvent === "issue_assigned";
  const updateEvent =
    event === "issue_updated" ||
    event === "jira:issue_updated" ||
    issueEvent === "issue_updated" ||
    issueEvent === "issue_generic";
  const assigneeChanges = changelogAssigneeChanges(record);
  if (!explicitAssign && !updateEvent && assigneeChanges.length === 0) {
    return { _tag: "not_assignment" };
  }

  const assignee =
    assigneeChanges.length > 0
      ? assigneeChanges[assigneeChanges.length - 1]
      : explicitAssign
        ? assigneeFromIssue(record)
        : null;
  if (assigneeChanges.length === 0 && !explicitAssign) {
    return { _tag: "ignored", reason: "assignee_unchanged" };
  }
  if (assignee === undefined || assignee === null) {
    return { _tag: "ignored", reason: "assignee_missing" };
  }
  if (assignee.accountId === null && assignee.displayName === null) {
    return { _tag: "ignored", reason: "assignee_cleared" };
  }

  const botAccountId = options?.botAccountId?.trim() || null;
  const matched =
    identityMatches(assignee.accountId, mention, botAccountId) ||
    identityMatches(assignee.displayName, mention, botAccountId);
  if (!matched) return { _tag: "ignored", reason: "assignee_not_bot" };

  const actor = readActor(record);
  const actorIsBot =
    (actor.accountId !== null &&
      assignee.accountId !== null &&
      normalizeIdentity(actor.accountId) === normalizeIdentity(assignee.accountId)) ||
    (botAccountId !== null &&
      actor.accountId !== null &&
      normalizeIdentity(actor.accountId) === normalizeIdentity(botAccountId));
  if (actorIsBot) return { _tag: "ignored", reason: "self_assignment" };

  const issue = readRecord(record.issue);
  const issueKeyRaw = asStringId(issue?.key as string | number | null | undefined);
  if (issueKeyRaw === null) return { _tag: "ignored", reason: "missing_issue" };
  const issueKey = issueKeyRaw.toUpperCase();
  const fields = readRecord(issue?.fields);
  const summary = asStringId(fields?.summary as string | number | null | undefined);
  const projectKey =
    asStringId(
      readRecord(fields?.project)?.key as string | number | null | undefined,
    )?.toUpperCase() || projectKeyFromIssueKey(issueKey);
  const description = fields && "description" in fields ? fields.description : null;
  const prompt = assignmentPrompt(summary, description);
  const stamp = assignmentStamp(record, assignee);

  return {
    _tag: "invocation",
    invocation: {
      issueKey,
      issueSummary: summary,
      projectKey,
      commentId: "",
      commentUrl: asStringId(issue?.self as string | number | null | undefined),
      replyToCommentId: "",
      commentSurface: "assignment",
      webhookEvent: "issue_assigned",
      commentUpdatedAt: stamp,
      actorAccountId: actor.accountId,
      actorDisplayName: actor.displayName,
      prompt,
      commentText: extractTextAndMentionsFromBody(description).text,
    },
  };
}

export type JiraAdfMention = {
  readonly accountId: string;
  readonly displayName?: string | null | undefined;
};

type AdfInlineNode =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "mention";
      readonly attrs: {
        readonly id: string;
        readonly text: string;
        readonly accessLevel: string;
      };
    };

type AdfParagraph = {
  readonly type: "paragraph";
  readonly content: ReadonlyArray<AdfInlineNode>;
};

export type JiraAdfDocument = {
  readonly type: "doc";
  readonly version: 1;
  readonly content: ReadonlyArray<AdfParagraph>;
};

// ADF mention attrs.id is a bare Atlassian account ID, not the accountid: wiki form.
// Strip that prefix from inbound wiki or automation values.
export function jiraMentionAccountId(accountId: string): string {
  const trimmed = accountId.trim();
  if (trimmed.length === 0) return trimmed;
  return trimmed.replace(/^accountid:/iu, "");
}

/**
 * Minimal ADF document from plain text paragraphs (API v3 comment body).
 * Optional leading @mention of the human requester (normal Jira reply style).
 *
 * Mention shape (matches real comments on this site):
 * `{ type: "mention", attrs: { id: "<accountId>", text: "@Name", accessLevel: "" } }`
 */
export function plainTextToAdf(
  text: string,
  options?: { readonly mention?: JiraAdfMention | null | undefined },
): JiraAdfDocument {
  const paragraphs = text
    .split(/\n{2,}/u)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);
  const blocks = paragraphs.length > 0 ? paragraphs : [text.trim() || " "];
  const mention = options?.mention;
  const accountId = jiraMentionAccountId(mention?.accountId?.trim() ?? "");
  const display = mention?.displayName?.trim().replace(/^@/u, "") || accountId;
  const mentionNode: AdfInlineNode | null =
    accountId.length > 0
      ? {
          type: "mention",
          attrs: {
            id: accountId,
            text: `@${display}`,
            accessLevel: "",
          },
        }
      : null;

  return {
    type: "doc",
    version: 1,
    content: blocks.map((block, index) => {
      if (index === 0 && mentionNode !== null) {
        return {
          type: "paragraph" as const,
          content: [mentionNode, { type: "text" as const, text: ` ${block}` }],
        };
      }
      return {
        type: "paragraph" as const,
        content: [{ type: "text" as const, text: block }],
      };
    }),
  };
}
