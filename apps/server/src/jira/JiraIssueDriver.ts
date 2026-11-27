/**
 * Jira as an upstream issue tracker (read path). A scope is a Jira project key (`SA`) and an issue
 * key its identifier (`SA-123`). It registers only when a Jira site URL is configured, signs with
 * the credential saved in Settings, and falls back to the server's Jira app account.
 */
import {
  type IssueActor,
  type IssueCapabilities,
  type IssueComment,
  type IssueState,
  type IssueViewerPermissions,
  type StandaloneIssueTrackerDescriptor,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type IssueInvolvementFilter,
  type StandaloneIssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { JIRA_ISSUE_TRACKER_KIND, jiraIssueBrowseUrl, jiraSiteHost } from "./jiraIssueLinks.ts";

const KIND = JIRA_ISSUE_TRACKER_KIND;
const COMMENTS_PAGE = 50;
const SUMMARY_FIELDS = [
  "summary",
  "status",
  "assignee",
  "reporter",
  "created",
  "updated",
  "resolutiondate",
  "labels",
  "comment",
];

/** Read-only: comments, transitions and edits stay with the Jira bridge's own app account. */
const CAPABILITIES: IssueCapabilities = {
  create: false,
  edit: false,
  comment: false,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: false,
  comment: false,
  edit: false,
  labels: false,
  assignees: false,
};

const JiraUser = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  avatarUrls: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  accountType: Schema.optional(Schema.String),
});
type JiraUser = typeof JiraUser.Type;

const JiraComment = Schema.Struct({
  id: Schema.String,
  author: Schema.optional(Schema.NullOr(JiraUser)),
  body: Schema.optional(Schema.Unknown),
  created: Schema.String,
});

const JiraCommentPage = Schema.Struct({
  comments: Schema.Array(JiraComment),
  startAt: Schema.optional(Schema.Number),
  maxResults: Schema.optional(Schema.Number),
  total: Schema.optional(Schema.Number),
});
type JiraCommentPage = typeof JiraCommentPage.Type;

const JiraIssue = Schema.Struct({
  key: Schema.String,
  fields: Schema.Struct({
    summary: Schema.optional(Schema.NullOr(Schema.String)),
    description: Schema.optional(Schema.Unknown),
    status: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          name: Schema.String,
          statusCategory: Schema.optional(Schema.Struct({ key: Schema.optional(Schema.String) })),
        }),
      ),
    ),
    assignee: Schema.optional(Schema.NullOr(JiraUser)),
    reporter: Schema.optional(Schema.NullOr(JiraUser)),
    created: Schema.String,
    updated: Schema.String,
    resolutiondate: Schema.optional(Schema.NullOr(Schema.String)),
    labels: Schema.optional(Schema.Array(Schema.String)),
    comment: Schema.optional(JiraCommentPage),
  }),
});
type JiraIssue = typeof JiraIssue.Type;

const JiraSearchPage = Schema.Struct({
  issues: Schema.Array(JiraIssue),
  nextPageToken: Schema.optional(Schema.NullOr(Schema.String)),
});

const JiraProjectPage = Schema.Struct({
  values: Schema.Array(Schema.Struct({ key: Schema.String, name: Schema.String })),
});

const optionalString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined));

const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(
    Config.option,
    Config.map(Option.map(Redacted.value)),
    Config.map(Option.getOrUndefined),
  );

/** The same names `JiraAppConfig` reads, without requiring the webhook half to be set up. */
const JiraSiteConfig = Config.all({
  baseUrl: optionalString("T3CODE_JIRA_URL"),
  legacyBaseUrl: optionalString("JIRA_URL"),
  siteUrl: optionalString("T3CODE_JIRA_SITE_URL"),
  username: optionalString("T3CODE_JIRA_USERNAME"),
  legacyUsername: optionalString("JIRA_USERNAME"),
  apiToken: optionalSecret("T3CODE_JIRA_API_TOKEN"),
  legacyApiToken: optionalSecret("JIRA_API_TOKEN"),
  authMode: Config.Literals(["basic", "bearer"] as const, "T3CODE_JIRA_AUTH_MODE").pipe(
    Config.withDefault("basic" as const),
  ),
});

export type JiraAuthorization =
  | { readonly _tag: "basic"; readonly username: string; readonly token: string }
  | { readonly _tag: "bearer"; readonly token: string };

/**
 * A stored credential is `email:api-token` for Jira Cloud, or a bare personal access token. A bare
 * token pairs with the configured username under basic auth, and is sent as a bearer otherwise.
 */
export function jiraAuthorizationFor(input: {
  readonly credential: string;
  readonly username: string | undefined;
  readonly authMode: "basic" | "bearer";
}): JiraAuthorization {
  const credential = input.credential.trim();
  const separator = credential.indexOf(":");
  if (separator > 0) {
    return {
      _tag: "basic",
      username: credential.slice(0, separator).trim(),
      token: credential.slice(separator + 1).trim(),
    };
  }
  if (input.authMode === "basic" && input.username !== undefined && input.username.length > 0) {
    return { _tag: "basic", username: input.username, token: credential };
  }
  return { _tag: "bearer", token: credential };
}

/** `https://<site>/browse/<KEY>-<n>`, the link Jira shares for an issue. */
export function parseJiraIssueUrl(siteHost: string, url: URL) {
  if (url.protocol !== "https:" || url.host.toLowerCase() !== siteHost) return null;
  const match = /\/browse\/([A-Z][A-Z0-9_]*)-([1-9][0-9]*)\/?$/u.exec(url.pathname);
  if (match === null) return null;
  return {
    host: siteHost,
    workspace: siteHost,
    scope: match[1]!,
    key: `${match[1]!}-${match[2]!}`,
  };
}

const BLOCK_NODES = new Set([
  "paragraph",
  "heading",
  "codeBlock",
  "blockquote",
  "listItem",
  "rule",
  "panel",
  "mediaSingle",
  "table",
  "tableRow",
]);

/** Jira's Atlassian Document Format as plain text, one line per block. */
function adfToPlainText(node: unknown): string {
  const lines: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim().length > 0) lines.push(current.trimEnd());
    current = "";
  };
  const visit = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string") {
      current += value;
      return;
    }
    if (typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "";
    if (type === "hardBreak") {
      flush();
      return;
    }
    if (type === "mention" || type === "emoji") {
      const attrs = (record.attrs ?? {}) as Record<string, unknown>;
      const text = typeof attrs.text === "string" ? attrs.text : "";
      current += text;
      return;
    }
    if (typeof record.text === "string") current += record.text;
    const block = BLOCK_NODES.has(type);
    if (block) flush();
    if (Array.isArray(record.content)) for (const child of record.content) visit(child);
    if (block) flush();
  };
  visit(node);
  flush();
  return lines.join("\n");
}

export function jiraJql(input: {
  readonly scope: string;
  readonly state: "all" | "open" | "closed";
  readonly involvement: IssueInvolvementFilter["involvement"];
  readonly query?: string | undefined;
  readonly labels?: ReadonlyArray<string> | undefined;
  readonly assignee?: string | undefined;
  readonly sort: "updated" | "created";
}): string {
  const quote = (value: string) => `"${value.replace(/["\\]/gu, (char) => `\\${char}`)}"`;
  const clauses = [`project = ${quote(input.scope.trim().toUpperCase())}`];
  if (input.state === "open") clauses.push("statusCategory != Done");
  if (input.state === "closed") clauses.push("statusCategory = Done");
  if (input.involvement === "assigned") clauses.push("assignee = currentUser()");
  if (input.involvement === "authored") clauses.push("reporter = currentUser()");
  // Jira has no "mentioned me" field; watching is the closest it records.
  if (input.involvement === "mentioned") clauses.push("watcher = currentUser()");
  const query = input.query?.trim();
  if (query !== undefined && query.length > 0) {
    clauses.push(
      /^[A-Z][A-Z0-9_]*-\d+$/iu.test(query)
        ? `(key = ${quote(query.toUpperCase())} OR text ~ ${quote(query)})`
        : `text ~ ${quote(query)}`,
    );
  }
  for (const label of input.labels ?? []) clauses.push(`labels = ${quote(label)}`);
  if (input.assignee !== undefined) clauses.push(`assignee = ${quote(input.assignee)}`);
  return `${clauses.join(" AND ")} ORDER BY ${input.sort === "created" ? "created" : "updated"} DESC`;
}

/** Jira writes `2024-05-01T10:00:00.000+0000`; links and lists expect ISO-8601 UTC. */
const isoDate = (value: string): string =>
  Option.match(DateTime.make(value.replace(/([+-]\d{2})(\d{2})$/u, "$1:$2")), {
    onNone: () => value,
    onSome: DateTime.formatIso,
  });

function toActor(user: JiraUser | null | undefined): IssueActor | null {
  if (user === null || user === undefined) return null;
  const login = user.accountId ?? user.name ?? user.displayName;
  if (login === undefined || login.trim().length === 0) return null;
  return {
    login,
    name: user.displayName ?? null,
    avatarUrl: user.avatarUrls?.["48x48"] ?? null,
    ...(user.accountType === "app" ? { isBot: true } : {}),
  };
}

function toState(status: JiraIssue["fields"]["status"]): IssueState {
  const name = status?.name?.trim() || "Unknown";
  return { category: status?.statusCategory?.key === "done" ? "closed" : "open", name };
}

function toComment(siteUrl: string, issueKey: string) {
  return (comment: typeof JiraComment.Type): IssueComment => ({
    id: comment.id,
    author: toActor(comment.author),
    body: adfToPlainText(comment.body),
    createdAt: isoDate(comment.created),
    url: `${jiraIssueBrowseUrl(siteUrl, issueKey)}?focusedCommentId=${encodeURIComponent(comment.id)}`,
  });
}

function nextCommentCursor(page: JiraCommentPage | undefined): string | null {
  if (page === undefined) return null;
  const startAt = page.startAt ?? 0;
  const seen = startAt + page.comments.length;
  return page.total !== undefined && seen < page.total ? String(seen) : null;
}

function toSummary(siteUrl: string, issue: JiraIssue): TrackerIssueSummary {
  const fields = issue.fields;
  const state = toState(fields.status);
  return {
    key: issue.key,
    displayKey: issue.key,
    title: fields.summary?.trim() || issue.key,
    url: jiraIssueBrowseUrl(siteUrl, issue.key),
    author: toActor(fields.reporter),
    state,
    createdAt: isoDate(fields.created),
    updatedAt: isoDate(fields.updated),
    closedAt:
      state.category === "closed" && fields.resolutiondate ? isoDate(fields.resolutiondate) : null,
    assignees: Option.toArray(Option.fromNullishOr(toActor(fields.assignee))),
    labels: (fields.labels ?? []).map((name) => ({ name, color: null })),
    commentCount: fields.comment?.total ?? fields.comment?.comments.length ?? 0,
  };
}

const failed = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  cause?: unknown,
) =>
  new IssueTrackerError({
    tracker: KIND,
    operation,
    reason,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

function reasonForStatus(status: number): IssueTrackerError["reason"] {
  if (status === 401 || status === 403) return "unauthenticated";
  if (status === 404) return "not-found";
  if (status === 429) return "rate-limited";
  return "failed";
}

/** The Jira tracker when a site URL is configured, otherwise none. */
export const trackers = Effect.gen(function* () {
  const site = yield* JiraSiteConfig.pipe(Effect.orDie);
  const rawBaseUrl = site.baseUrl?.trim() || site.legacyBaseUrl?.trim();
  if (rawBaseUrl === undefined || rawBaseUrl.length === 0) return [];
  const baseUrl = rawBaseUrl.replace(/\/+$/u, "");
  const siteUrl = (site.siteUrl?.trim() || baseUrl).replace(/\/+$/u, "");
  const siteHost = jiraSiteHost(siteUrl);
  const username = site.username?.trim() || site.legacyUsername?.trim();
  const appToken = site.apiToken?.trim() || site.legacyApiToken?.trim();
  const httpClient = yield* HttpClient.HttpClient;
  const host = yield* IssueTrackerHost.IssueTrackerHost;

  const descriptor: StandaloneIssueTrackerDescriptor = {
    tracker: KIND,
    displayName: "Jira",
    host: siteHost,
    scopeNoun: "project",
    credential: {
      label: "API token (email:token)",
      helpUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    },
  };

  const credential = (operation: string, token: string | undefined) =>
    token !== undefined
      ? Effect.succeed(token)
      : host.credentials.get(KIND).pipe(
          Effect.flatMap((stored) => {
            const value = Option.getOrUndefined(stored) ?? appToken;
            return value === undefined || value.trim().length === 0
              ? Effect.fail(failed(operation, "unauthenticated", "Jira is not connected."))
              : Effect.succeed(value);
          }),
        );

  const authorize = (request: HttpClientRequest.HttpClientRequest, token: string) => {
    const auth = jiraAuthorizationFor({ credential: token, username, authMode: site.authMode });
    if (auth._tag === "bearer") return request.pipe(HttpClientRequest.bearerToken(auth.token));
    const basic = Buffer.from(`${auth.username}:${auth.token}`, "utf8").toString("base64");
    return request.pipe(HttpClientRequest.setHeader("authorization", `Basic ${basic}`));
  };

  const call = Effect.fn("JiraIssueDriver.call")(function* <A, I>(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I>,
    token?: string,
  ): Effect.fn.Return<A, IssueTrackerError> {
    const key = yield* credential(operation, token);
    const response = yield* httpClient
      .execute(
        authorize(
          request.pipe(
            HttpClientRequest.acceptJson,
            HttpClientRequest.setHeader("user-agent", "t3-code-jira-tracker"),
          ),
          key,
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          failed(operation, "failed", "Jira could not be reached.", cause),
        ),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* failed(
        operation,
        reasonForStatus(response.status),
        `Jira answered ${response.status}.`,
      );
    }
    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError((cause) =>
        failed(operation, "failed", "Jira sent a response T3 could not read.", cause),
      ),
    );
  });

  const get = (path: string) => HttpClientRequest.get(`${baseUrl}${path}`);
  const myself = (token?: string) => call("viewer", get("/rest/api/3/myself"), JiraUser, token);

  const api: StandaloneIssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    standalone: descriptor,
    parseIssueUrl: (url) => parseJiraIssueUrl(siteHost, url),

    probeCredential: Effect.fn("JiraIssueDriver.probeCredential")(function* (token) {
      const viewer = yield* myself(token);
      const projects = yield* call(
        "probeCredential",
        get("/rest/api/3/project/search?maxResults=100&orderBy=key"),
        JiraProjectPage,
        token,
      );
      return {
        account: viewer.displayName ?? viewer.accountId ?? viewer.name ?? "Jira user",
        workspace: siteHost,
        scopes: projects.values.map((project) => ({ key: project.key, name: project.name })),
      };
    }),

    getViewer: () =>
      myself().pipe(
        Effect.flatMap((viewer) => {
          const actor = toActor(viewer);
          return actor === null
            ? Effect.fail(failed("viewer", "failed", "Jira did not name the signed-in account."))
            : Effect.succeed(actor.login);
        }),
      ),

    listIssues: Effect.fn("JiraIssueDriver.listIssues")(function* (input) {
      const page = yield* call(
        "listIssues",
        HttpClientRequest.post(`${baseUrl}/rest/api/3/search/jql`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            jql: jiraJql(input),
            maxResults: input.limit,
            fields: SUMMARY_FIELDS,
            ...(input.cursor === undefined ? {} : { nextPageToken: input.cursor }),
          }),
        ),
        JiraSearchPage,
      );
      return {
        items: page.issues.map((issue) => toSummary(siteUrl, issue)),
        nextCursor: page.nextPageToken ?? null,
      };
    }),

    getIssue: Effect.fn("JiraIssueDriver.getIssue")(function* (input) {
      const [issue, viewer] = yield* Effect.all(
        [
          call(
            "getIssue",
            get(
              `/rest/api/3/issue/${encodeURIComponent(input.key)}?fields=${[...SUMMARY_FIELDS, "description"].join(",")}`,
            ),
            JiraIssue,
          ),
          myself().pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 2 },
      );
      const summary = toSummary(siteUrl, issue);
      const comments = issue.fields.comment;
      return {
        ...summary,
        body: adfToPlainText(issue.fields.description),
        viewer: toActor(viewer)?.login ?? null,
        viewerPermissions: VIEWER_PERMISSIONS,
        states: [summary.state],
        comments: (comments?.comments ?? []).map(toComment(siteUrl, issue.key)),
        commentsCursor: nextCommentCursor(comments),
        events: [],
        linkedPullRequests: [],
      };
    }),

    getIssueLink: Effect.fn("JiraIssueDriver.getIssueLink")(function* (input) {
      const issue = yield* call(
        "getIssueLink",
        get(`/rest/api/3/issue/${encodeURIComponent(input.key)}?fields=summary`),
        Schema.Struct({
          key: Schema.String,
          fields: Schema.Struct({ summary: Schema.optional(Schema.NullOr(Schema.String)) }),
        }),
      );
      return {
        title: issue.fields.summary?.trim() || issue.key,
        url: jiraIssueBrowseUrl(siteUrl, issue.key),
        displayKey: issue.key,
      };
    }),

    getComments: Effect.fn("JiraIssueDriver.getComments")(function* (input) {
      const page = yield* call(
        "getComments",
        get(
          `/rest/api/3/issue/${encodeURIComponent(input.key)}/comment?startAt=${encodeURIComponent(input.cursor)}&maxResults=${COMMENTS_PAGE}&orderBy=created`,
        ),
        JiraCommentPage,
      );
      return {
        comments: page.comments.map(toComment(siteUrl, input.key)),
        nextCursor: nextCommentCursor(page),
      };
    }),
  };
  return [api];
});

/**
 * A server with a fork Jira site keeps this tracker (app-account fallback, site-host thread links)
 * in place of upstream's credential-only Jira tracker; one kind may register only once.
 */
export const withStandalone = <T extends { readonly kind: string }>(standalone: ReadonlyArray<T>) =>
  Effect.map(trackers, (fork) =>
    fork.length === 0
      ? standalone
      : [...standalone.filter((tracker) => tracker.kind !== KIND), ...fork],
  );
