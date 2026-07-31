import * as Schema from "effect/Schema";

const NonEmpty = Schema.String.check(Schema.isNonEmpty());

export const GitHubIssueCommentWebhook = Schema.Struct({
  action: Schema.String,
  installation: Schema.Struct({
    id: Schema.Number,
  }),
  repository: Schema.Struct({
    id: Schema.Number,
    full_name: NonEmpty,
    html_url: NonEmpty,
  }),
  issue: Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    html_url: NonEmpty,
    pull_request: Schema.optional(Schema.Unknown),
  }),
  comment: Schema.Struct({
    id: Schema.Number,
    body: Schema.String,
    html_url: NonEmpty,
    user: Schema.Struct({
      id: Schema.Number,
      login: NonEmpty,
      type: Schema.optional(Schema.String),
    }),
  }),
  sender: Schema.Struct({
    id: Schema.Number,
    login: NonEmpty,
    type: Schema.optional(Schema.String),
  }),
});
export type GitHubIssueCommentWebhook = typeof GitHubIssueCommentWebhook.Type;

/** Inline review comment on the Files changed tab (`pull_request_review_comment`). */
export const GitHubPullRequestReviewCommentWebhook = Schema.Struct({
  action: Schema.String,
  installation: Schema.Struct({
    id: Schema.Number,
  }),
  repository: Schema.Struct({
    id: Schema.Number,
    full_name: NonEmpty,
    html_url: NonEmpty,
  }),
  pull_request: Schema.Struct({
    number: Schema.Number,
    title: Schema.String,
    html_url: NonEmpty,
  }),
  comment: Schema.Struct({
    id: Schema.Number,
    body: Schema.String,
    html_url: NonEmpty,
    path: NonEmpty,
    line: Schema.optional(Schema.NullOr(Schema.Number)),
    original_line: Schema.optional(Schema.NullOr(Schema.Number)),
    side: Schema.optional(Schema.NullOr(Schema.String)),
    diff_hunk: Schema.optional(Schema.NullOr(Schema.String)),
    commit_id: Schema.optional(Schema.NullOr(Schema.String)),
    /**
     * Present when this comment is itself a reply. GitHub only accepts new replies
     * against the top-level review comment, so callers must use this (or id) as
     * the reply parent — never a nested reply id.
     */
    in_reply_to_id: Schema.optional(Schema.NullOr(Schema.Number)),
    user: Schema.Struct({
      id: Schema.Number,
      login: NonEmpty,
      type: Schema.optional(Schema.String),
    }),
  }),
  sender: Schema.Struct({
    id: Schema.Number,
    login: NonEmpty,
    type: Schema.optional(Schema.String),
  }),
});
export type GitHubPullRequestReviewCommentWebhook =
  typeof GitHubPullRequestReviewCommentWebhook.Type;

/** Where the source mention lived and where the bridge should reply. */
export type GitHubCommentSurface = "issue" | "review";

export interface GitHubReviewCommentContext {
  readonly path: string;
  readonly line: number | null;
  readonly originalLine: number | null;
  readonly side: string | null;
  readonly diffHunk: string | null;
  readonly commitId: string | null;
}

export interface GitHubPrInvocation {
  readonly installationId: number;
  readonly repositoryId: number;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly pullRequestTitle: string;
  readonly pullRequestUrl: string;
  /** Comment that carried the mention (eyes reaction target). */
  readonly commentId: number;
  readonly commentUrl: string;
  /**
   * Parent for a review-thread reply. Always a top-level review comment id
   * (`in_reply_to_id` when the mention is nested, else `commentId`).
   * For issue-surface invocations this equals `commentId` and is unused for posting.
   */
  readonly replyToCommentId: number;
  readonly commentSurface: GitHubCommentSurface;
  readonly actorId: number;
  readonly actorLogin: string;
  readonly prompt: string;
  readonly reviewContext: GitHubReviewCommentContext | null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Strip a leading `@mention` and return the remaining prompt, or null if not an invocation. */
export function extractMentionPrompt(body: string, mention: string): string | null {
  const normalizedMention = mention.trim().replace(/^@/u, "");
  if (normalizedMention.length === 0) return null;
  const matcher = new RegExp(`(?:^|\\s)@${escapeRegExp(normalizedMention)}(?:\\s+|$)`, "iu");
  const match = matcher.exec(body);
  if (!match) return null;
  const prompt = body.slice(match.index + match[0].length).trim();
  if (prompt.length === 0) return null;
  return prompt;
}

/**
 * Where the GitHub turn should run:
 * - `sibling`: PR-worktree session dedicated to a GH review discussion (or forced fresh)
 * - `main`: reuse the live PR / Discord implementation thread (full history)
 *
 * Surface defaults (when no flag is present):
 * - conversation (`issue`): `main`
 * - inline review (`review`): `sibling` (reuse the T3 thread already assigned to that
 *   GH review discussion when one exists; create only on first mention)
 *
 * Flags (stripped from the prompt): `main-thread`, `sibling-thread`, `--thread main|sibling|new`
 */
export type GitHubThreadMode = "sibling" | "main";

export function defaultGitHubThreadMode(surface: GitHubCommentSurface): GitHubThreadMode {
  return surface === "review" ? "sibling" : "main";
}

export function parseGitHubThreadMode(raw: string): {
  /** Explicit flag, or `null` to use {@link defaultGitHubThreadMode}. */
  readonly mode: GitHubThreadMode | null;
  readonly prompt: string;
} {
  const tokens = raw
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  let mode: GitHubThreadMode | null = null;
  const promptParts: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const lower = token.toLowerCase();
    if (lower === "main-thread" || lower === "--main-thread") {
      mode = "main";
      continue;
    }
    if (lower === "sibling-thread" || lower === "--sibling-thread") {
      mode = "sibling";
      continue;
    }
    if (token === "--thread") {
      const value = tokens[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        const target = value.toLowerCase();
        if (target === "main") mode = "main";
        else if (target === "sibling" || target === "new") mode = "sibling";
        index += 1;
        continue;
      }
    }
    promptParts.push(token);
  }

  return { mode, prompt: promptParts.join(" ").trim() };
}

export function parseGitHubPrInvocation(
  payload: GitHubIssueCommentWebhook,
  mention: string,
): GitHubPrInvocation | null {
  if (payload.action !== "created" || payload.issue.pull_request === undefined) return null;
  if (payload.sender.type === "Bot" || payload.comment.user.type === "Bot") return null;

  const prompt = extractMentionPrompt(payload.comment.body, mention);
  if (prompt === null) return null;

  return {
    installationId: payload.installation.id,
    repositoryId: payload.repository.id,
    repository: payload.repository.full_name,
    pullRequestNumber: payload.issue.number,
    pullRequestTitle: payload.issue.title,
    pullRequestUrl: payload.issue.html_url,
    commentId: payload.comment.id,
    commentUrl: payload.comment.html_url,
    replyToCommentId: payload.comment.id,
    commentSurface: "issue",
    actorId: payload.sender.id,
    actorLogin: payload.sender.login,
    prompt,
    reviewContext: null,
  };
}

export function parseGitHubReviewCommentInvocation(
  payload: GitHubPullRequestReviewCommentWebhook,
  mention: string,
): GitHubPrInvocation | null {
  if (payload.action !== "created") return null;
  if (payload.sender.type === "Bot" || payload.comment.user.type === "Bot") return null;

  const prompt = extractMentionPrompt(payload.comment.body, mention);
  if (prompt === null) return null;

  // GitHub rejects replies that target a nested reply; always anchor to the thread root.
  const replyToCommentId = payload.comment.in_reply_to_id ?? payload.comment.id;

  return {
    installationId: payload.installation.id,
    repositoryId: payload.repository.id,
    repository: payload.repository.full_name,
    pullRequestNumber: payload.pull_request.number,
    pullRequestTitle: payload.pull_request.title,
    pullRequestUrl: payload.pull_request.html_url,
    commentId: payload.comment.id,
    commentUrl: payload.comment.html_url,
    replyToCommentId,
    commentSurface: "review",
    actorId: payload.sender.id,
    actorLogin: payload.sender.login,
    prompt,
    reviewContext: {
      path: payload.comment.path,
      line: payload.comment.line ?? null,
      originalLine: payload.comment.original_line ?? null,
      side: payload.comment.side ?? null,
      diffHunk: payload.comment.diff_hunk ?? null,
      commitId: payload.comment.commit_id ?? null,
    },
  };
}
