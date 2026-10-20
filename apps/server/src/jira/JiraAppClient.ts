import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { JiraAppConfig } from "./JiraAppConfig.ts";
import {
  appendAdfSection,
  confluenceBrowseUrl,
  confluenceLinksUrl,
  confluenceRestBase,
  jiraAttachmentBrowseUrl,
  readConfluenceAtlasDoc,
} from "./JiraCommentPublish.ts";
import { markdownToAdf, type JiraAdfDoc, type JiraStoredOverflow } from "./JiraMarkdown.ts";

const encodeUnknownJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class JiraAppClient extends Context.Service<
  JiraAppClient,
  {
    readonly addIssueComment: (input: {
      readonly issueKey: string;
      readonly body: string;
      /**
       * When set, create a threaded **reply** under this comment (Jira `parentId`).
       * Only top-level comments accept children; the client resolves nested ids to the
       * thread root via GET before posting.
       */
      readonly parentCommentId?: string | null;
      /**
       * Second parent to try if `parentCommentId` is rejected (e.g. root vs mention).
       * Keeps the reply inline when the first parentId is invalid.
       */
      readonly fallbackParentCommentId?: string | null;
      /** @-mention this Jira user at the start of the reply (normal reply style). */
      readonly mentionAccountId?: string | null;
      readonly mentionDisplayName?: string | null;
    }) => Effect.Effect<{ readonly id: string; readonly parentId: string | null } | null, never>;
    /**
     * Best-effort reaction on a comment (👀). Jira Cloud support varies; returns the emoji id
     * when the site accepted the reaction, otherwise null.
     */
    readonly addCommentReaction: (input: {
      readonly issueKey: string;
      readonly commentId: string;
      readonly emojiId: string;
    }) => Effect.Effect<string | null, never>;
    readonly removeCommentReaction: (input: {
      readonly issueKey: string;
      readonly commentId: string;
      readonly emojiId: string;
    }) => Effect.Effect<void, never>;
    /** Upload the overflow Markdown onto the issue. Null when Jira rejects it. */
    readonly addIssueAttachment: (input: {
      readonly issueKey: string;
      readonly filename: string;
      readonly markdown: string;
    }) => Effect.Effect<JiraStoredOverflow | null, never>;
    /**
     * Append one heading to the issue's page under the assigned Confluence parents.
     * Null when no gateway base is configured or the write is rejected.
     */
    readonly publishConfluenceSection: (input: {
      readonly issueKey: string;
      readonly spaceKey: string;
      readonly parentTitles: ReadonlyArray<string>;
      readonly title: string;
      readonly heading: string;
      readonly markdown: string;
    }) => Effect.Effect<JiraStoredOverflow | null, never>;
  }
>()("t3/jira/JiraAppClient") {}

const CommentResponse = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  parentId: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
});

const CommentGetResponse = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  parentId: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Null])),
});

export const make = Effect.gen(function* () {
  const config = yield* JiraAppConfig;
  const httpClient = yield* HttpClient.HttpClient;

  const authorize = (request: HttpClientRequest.HttpClientRequest) => {
    if (!config.enabled) return request;
    if (config.authMode === "bearer") {
      return request.pipe(HttpClientRequest.bearerToken(config.apiToken));
    }
    const token = Buffer.from(`${config.username}:${config.apiToken}`, "utf8").toString("base64");
    return request.pipe(HttpClientRequest.setHeader("authorization", `Basic ${token}`));
  };

  /**
   * Jira only allows children under **root** comments. Nesting under a reply returns 400
   * ("Parent comment not found, and no child comments exist"). Resolve any comment id to
   * the thread root via GET `/rest/api/3/issue/{key}/comment/{id}` (`parentId` or self).
   */
  const resolveThreadRootCommentId = Effect.fn("JiraAppClient.resolveThreadRootCommentId")(
    function* (issueKey: string, commentId: string): Effect.fn.Return<string | null> {
      const trimmed = commentId.trim();
      if (trimmed.length === 0) return null;
      if (!config.enabled) return trimmed;

      const url = `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment/${encodeURIComponent(trimmed)}`;
      const request = authorize(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("user-agent", "t3-code-jira-bridge"),
        ),
      );
      const response = yield* httpClient.execute(request).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Jira comment GET for thread root failed", {
            issueKey,
            commentId: trimmed,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
      if (response === null) return trimmed;

      return yield* HttpClientResponse.matchStatus(response, {
        "2xx": (success) =>
          HttpClientResponse.schemaBodyJson(CommentGetResponse)(success).pipe(
            Effect.map((parsed) => {
              const parentRaw = parsed.parentId;
              if (parentRaw === undefined || parentRaw === null) return String(parsed.id);
              const parent = String(parentRaw).trim();
              return parent.length > 0 ? parent : String(parsed.id);
            }),
            Effect.tap((rootId) =>
              rootId !== trimmed
                ? Effect.logInfo("Resolved Jira nested comment to thread root", {
                    issueKey,
                    commentId: trimmed,
                    threadRootId: rootId,
                  })
                : Effect.void,
            ),
            Effect.tapError((cause) =>
              Effect.logWarning("Jira comment GET decode failed; using id as root candidate", {
                issueKey,
                commentId: trimmed,
                cause,
              }),
            ),
            Effect.orElseSucceed(() => trimmed),
          ),
        orElse: Effect.fn("JiraAppClient.resolveThreadRootCommentId.rejected")(function* (failed) {
          const detail = yield* failed.text.pipe(Effect.orElseSucceed(() => ""));
          yield* Effect.logWarning("Jira comment GET rejected; using id as root candidate", {
            issueKey,
            commentId: trimmed,
            status: failed.status,
            detail: detail.slice(0, 300),
          });
          return trimmed;
        }),
      });
    },
  );

  const addIssueComment = Effect.fn("JiraAppClient.addIssueComment")(function* (input: {
    readonly issueKey: string;
    readonly body: string;
    readonly parentCommentId?: string | null;
    readonly fallbackParentCommentId?: string | null;
    readonly mentionAccountId?: string | null;
    readonly mentionDisplayName?: string | null;
  }) {
    if (!config.enabled) return null;

    const url = `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`;
    const adfBody = markdownToAdf(input.body, {
      platform: "jira",
      mention: input.mentionAccountId
        ? {
            accountId: input.mentionAccountId,
            displayName: input.mentionDisplayName,
          }
        : null,
    });

    /** Jira accepts parentId as string or number; prefer numeric when pure digits. */
    const parentIdValue = (raw: string): string | number =>
      /^\d+$/u.test(raw) ? Number(raw) : raw;

    const postOnce = (body: Record<string, unknown>, parentForLog: string | null) => {
      const request = authorize(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("user-agent", "t3-code-jira-bridge"),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      );
      return httpClient.execute(request).pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Jira comment create request failed", {
            issueKey: input.issueKey,
            parentCommentId: parentForLog,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );
    };

    const decodeSuccess = (
      success: HttpClientResponse.HttpClientResponse,
      parentForLog: string | null,
    ) =>
      HttpClientResponse.schemaBodyJson(CommentResponse)(success).pipe(
        Effect.map((parsed) => {
          const parentRaw = parsed.parentId;
          const parentId =
            parentRaw === undefined || parentRaw === null ? null : String(parentRaw).trim() || null;
          return { id: String(parsed.id), parentId };
        }),
        Effect.tapError((cause) =>
          Effect.logWarning("Jira comment create response decode failed", {
            issueKey: input.issueKey,
            parentCommentId: parentForLog,
            cause,
          }),
        ),
        Effect.orElseSucceed(() => null),
      );

    type Attempt =
      | { readonly _tag: "ok"; readonly id: string; readonly parentId: string | null }
      | { readonly _tag: "retry_next" }
      | { readonly _tag: "failed" };

    const tryPost = Effect.fn("JiraAppClient.addIssueComment.tryPost")(function* (
      parentCommentId: string | null,
    ): Effect.fn.Return<Attempt> {
      const payload: Record<string, unknown> = { body: adfBody };
      // Jira Cloud: parentId threads under a **root** comment only.
      if (parentCommentId !== null) {
        payload.parentId = parentIdValue(parentCommentId);
      }
      const response = yield* postOnce(payload, parentCommentId);
      if (response === null) return { _tag: "failed" as const };

      return yield* HttpClientResponse.matchStatus(response, {
        "2xx": (success) =>
          decodeSuccess(success, parentCommentId).pipe(
            Effect.map((parsed) =>
              parsed === null
                ? ({ _tag: "failed" } as const)
                : ({ _tag: "ok", id: parsed.id, parentId: parsed.parentId } as const),
            ),
          ),
        orElse: Effect.fn("JiraAppClient.addIssueComment.rejected")(function* (failed) {
          const detail = yield* failed.text.pipe(Effect.orElseSucceed(() => ""));
          // Threading can fail if parentId is invalid / not a root — try next parent.
          if (parentCommentId !== null && (failed.status === 400 || failed.status === 404)) {
            yield* Effect.logWarning("Jira threaded comment rejected; trying next parent", {
              issueKey: input.issueKey,
              parentCommentId,
              status: failed.status,
              detail: detail.slice(0, 500),
            });
            return { _tag: "retry_next" as const };
          }
          yield* Effect.logWarning("Jira comment create rejected", {
            issueKey: input.issueKey,
            parentCommentId,
            status: failed.status,
            detail: detail.slice(0, 500),
          });
          return { _tag: "failed" as const };
        }),
      });
    });

    const primary = input.parentCommentId?.trim() || null;
    const secondary = input.fallbackParentCommentId?.trim() || null;

    // Resolve nested mention/reply ids to thread roots before posting. Live probe on SA-421:
    // parentId=child → 400; parentId=root → 200 with parentId set.
    const resolvedRoots: string[] = [];
    for (const candidate of [primary, secondary]) {
      if (candidate === null) continue;
      const root = yield* resolveThreadRootCommentId(input.issueKey, candidate);
      if (root !== null && !resolvedRoots.includes(root)) {
        resolvedRoots.push(root);
      }
    }

    // Prefer inline reply under resolved roots; top-level only as last resort.
    const parents: Array<string | null> = [...resolvedRoots, null];

    for (const parent of parents) {
      const result = yield* tryPost(parent);
      if (result._tag === "ok") {
        if (parent !== null && result.parentId === null) {
          // API accepted body but ignored parentId (e.g. wrong shape). Loud so we notice.
          yield* Effect.logError("Jira comment created without parentId despite request", {
            issueKey: input.issueKey,
            requestedParentId: parent,
            createdCommentId: result.id,
          });
        } else if (parent !== null) {
          yield* Effect.logInfo("Posted Jira inline threaded reply", {
            issueKey: input.issueKey,
            parentId: result.parentId ?? parent,
            createdCommentId: result.id,
          });
        }
        return { id: result.id, parentId: result.parentId };
      }
      if (result._tag === "failed") return null;
      // retry_next → continue
    }
    return null;
  });

  /**
   * Try a few known reaction endpoint shapes. Official Jira Cloud REST still lacks a stable
   * public "react to comment" resource; UI uses internal services. Best-effort only.
   */
  const addCommentReaction = Effect.fn("JiraAppClient.addCommentReaction")(function* (input: {
    readonly issueKey: string;
    readonly commentId: string;
    readonly emojiId: string;
  }) {
    if (!config.enabled) return null;
    const emojiId = input.emojiId.trim();
    if (emojiId.length === 0) return null;

    const candidates = [
      {
        url: `${config.baseUrl}/rest/api/3/comment/${encodeURIComponent(input.commentId)}/reactions`,
        body: { emojiId } as Record<string, unknown>,
      },
      {
        url: `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment/${encodeURIComponent(input.commentId)}/reactions`,
        body: { emojiId } as Record<string, unknown>,
      },
      {
        // Some deployments accept the unicode / shortname form.
        url: `${config.baseUrl}/rest/api/3/comment/${encodeURIComponent(input.commentId)}/reactions`,
        body: { emoji: "👀" } as Record<string, unknown>,
      },
    ];

    for (const candidate of candidates) {
      const request = authorize(
        HttpClientRequest.post(candidate.url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("user-agent", "t3-code-jira-bridge"),
          HttpClientRequest.bodyJsonUnsafe(candidate.body),
        ),
      );
      const response = yield* httpClient.execute(request).pipe(Effect.orElseSucceed(() => null));
      if (response === null) continue;
      const ok = yield* HttpClientResponse.matchStatus(response, {
        "2xx": () => Effect.succeed(true),
        orElse: Effect.fn("JiraAppClient.addCommentReaction.rejected")(function* (failed) {
          if (failed.status === 404 || failed.status === 405) return false;
          const detail = yield* failed.text.pipe(Effect.orElseSucceed(() => ""));
          yield* Effect.logDebug("Jira comment reaction attempt rejected", {
            issueKey: input.issueKey,
            commentId: input.commentId,
            status: failed.status,
            detail: detail.slice(0, 200),
          });
          return false;
        }),
      });
      if (ok) {
        yield* Effect.logInfo("Added Jira comment acknowledgment reaction", {
          issueKey: input.issueKey,
          commentId: input.commentId,
          emojiId,
        });
        return emojiId;
      }
    }

    yield* Effect.logWarning(
      "Jira comment reaction unsupported on this site; continuing without ack reaction",
      {
        issueKey: input.issueKey,
        commentId: input.commentId,
        emojiId,
      },
    );
    return null;
  });

  const removeCommentReaction = Effect.fn("JiraAppClient.removeCommentReaction")(function* (input: {
    readonly issueKey: string;
    readonly commentId: string;
    readonly emojiId: string;
  }) {
    if (!config.enabled) return;
    const emojiId = input.emojiId.trim();
    if (emojiId.length === 0) return;

    const candidates = [
      `${config.baseUrl}/rest/api/3/comment/${encodeURIComponent(input.commentId)}/reactions/${encodeURIComponent(emojiId)}`,
      `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment/${encodeURIComponent(input.commentId)}/reactions/${encodeURIComponent(emojiId)}`,
      `${config.baseUrl}/rest/api/3/comment/${encodeURIComponent(input.commentId)}/reactions/1f440`,
    ];

    for (const url of candidates) {
      const request = authorize(
        HttpClientRequest.delete(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("user-agent", "t3-code-jira-bridge"),
        ),
      );
      const response = yield* httpClient.execute(request).pipe(Effect.orElseSucceed(() => null));
      if (response === null) continue;
      const ok = yield* HttpClientResponse.matchStatus(response, {
        "2xx": () => Effect.succeed(true),
        "204": () => Effect.succeed(true),
        orElse: () => Effect.succeed(false),
      });
      if (ok) {
        yield* Effect.logInfo("Removed Jira comment acknowledgment reaction", {
          issueKey: input.issueKey,
          commentId: input.commentId,
          emojiId,
        });
        return;
      }
    }
  });

  let siteBaseCache: string | null | undefined;

  const sendJson = (
    request: HttpClientRequest.HttpClientRequest,
    failureMessage: string,
    issueKey: string,
  ) =>
    httpClient.execute(request).pipe(
      Effect.flatMap((response) =>
        HttpClientResponse.schemaBodyJson(Schema.Unknown)(response).pipe(
          Effect.map((payload) => ({ status: response.status, payload })),
          Effect.orElseSucceed(() => ({ status: response.status, payload: null as unknown })),
        ),
      ),
      Effect.tapError((cause) => Effect.logWarning(failureMessage, { issueKey, cause })),
      Effect.orElseSucceed(() => null),
    );

  const jsonRequest = (request: HttpClientRequest.HttpClientRequest) =>
    authorize(
      request.pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader("user-agent", "t3-code-jira-bridge"),
      ),
    );

  const loadSiteBase = Effect.fn("JiraAppClient.siteBase")(function* (issueKey: string) {
    if (siteBaseCache !== undefined) return siteBaseCache;
    if (!config.enabled) {
      siteBaseCache = null;
      return null;
    }
    const result = yield* sendJson(
      jsonRequest(HttpClientRequest.get(`${config.baseUrl}/rest/api/3/serverInfo`)),
      "Jira serverInfo request failed",
      issueKey,
    );
    const baseUrl =
      result !== null && result.status >= 200 && result.status < 300
        ? readString(result.payload, "baseUrl")
        : null;
    siteBaseCache = baseUrl?.replace(/\/+$/u, "") ?? null;
    return siteBaseCache;
  });

  const addIssueAttachment = Effect.fn("JiraAppClient.addIssueAttachment")(function* (input: {
    readonly issueKey: string;
    readonly filename: string;
    readonly markdown: string;
  }) {
    if (!config.enabled) return null;
    const filename = input.filename.trim() || "response.md";
    const url = `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/attachments`;
    const result = yield* sendJson(
      authorize(
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeader("user-agent", "t3-code-jira-bridge"),
          HttpClientRequest.setHeader("X-Atlassian-Token", "no-check"),
          HttpClientRequest.bodyFormDataRecord({
            file: new File([input.markdown], filename, { type: "text/markdown;charset=utf-8" }),
          }),
        ),
      ),
      "Jira attachment upload failed",
      input.issueKey,
    );
    if (result === null || result.status < 200 || result.status >= 300) {
      if (result !== null) {
        yield* Effect.logWarning("Jira attachment upload rejected", {
          issueKey: input.issueKey,
          status: result.status,
          detail: errorDetail(result.payload),
        });
      }
      return null;
    }
    const attachment = firstAttachment(result.payload);
    if (attachment === null) {
      yield* Effect.logWarning("Jira attachment upload response had no file", {
        issueKey: input.issueKey,
        status: result.status,
      });
      return null;
    }
    const site = yield* loadSiteBase(input.issueKey);
    return {
      kind: "attachment" as const,
      label: attachment.filename ?? filename,
      url: jiraAttachmentBrowseUrl(site, {
        id: attachment.id,
        content: attachment.content,
      }),
    };
  });

  const publishConfluenceSection = Effect.fn("JiraAppClient.publishConfluenceSection")(
    function* (input: {
      readonly issueKey: string;
      readonly spaceKey: string;
      readonly parentTitles: ReadonlyArray<string>;
      readonly title: string;
      readonly heading: string;
      readonly markdown: string;
    }) {
      if (!config.enabled) return null;
      const rest = confluenceRestBase(config.baseUrl);
      if (rest === null) return null;

      const confluenceCall = (
        method: "GET" | "POST" | "PUT",
        path: string,
        query?: Readonly<Record<string, string>>,
        body?: unknown,
      ) => {
        const url = new URL(`${rest}${path}`);
        if (query !== undefined) {
          for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
        }
        const init =
          method === "GET"
            ? HttpClientRequest.get(url.toString())
            : method === "POST"
              ? HttpClientRequest.post(url.toString())
              : HttpClientRequest.put(url.toString());
        const request =
          body === undefined
            ? jsonRequest(init)
            : jsonRequest(init).pipe(HttpClientRequest.bodyJsonUnsafe(body));
        return sendJson(request, "Confluence request failed", input.issueKey);
      };

      const warnUnlessOk = (label: string, result: { status: number; payload: unknown } | null) => {
        if (result === null || (result.status >= 200 && result.status < 300)) return Effect.void;
        return Effect.logWarning(label, {
          issueKey: input.issueKey,
          spaceKey: input.spaceKey,
          status: result.status,
          detail: errorDetail(result.payload),
        });
      };

      const spaceResult = yield* confluenceCall("GET", "/api/v2/spaces", {
        keys: input.spaceKey,
        limit: "5",
      });
      yield* warnUnlessOk("Confluence space lookup rejected", spaceResult);
      const spaceId =
        spaceResult !== null && spaceResult.status >= 200 && spaceResult.status < 300
          ? spaceIdFromList(spaceResult.payload, input.spaceKey)
          : null;
      if (spaceId === null) {
        if (spaceResult !== null && spaceResult.status >= 200 && spaceResult.status < 300) {
          yield* Effect.logWarning("Confluence space was not found", {
            issueKey: input.issueKey,
            spaceKey: input.spaceKey,
          });
        }
        return null;
      }

      const findPage = Effect.fn("JiraAppClient.findPage")(function* (title: string) {
        const result = yield* confluenceCall("GET", "/api/v2/pages", {
          "space-id": spaceId,
          title,
          status: "current",
          limit: "5",
        });
        yield* warnUnlessOk("Confluence page lookup rejected", result);
        if (result === null || result.status < 200 || result.status >= 300) return null;
        return pagesFromList(result.payload).find((page) => page.title === title) ?? null;
      });

      const createPage = Effect.fn("JiraAppClient.createPage")(function* (
        title: string,
        pageParentId: string | null,
        doc: JiraAdfDoc,
      ): Effect.fn.Return<{ readonly id: string; readonly payload: unknown } | null> {
        const result = yield* confluenceCall("POST", "/api/v2/pages", undefined, {
          spaceId,
          status: "current",
          title,
          ...(pageParentId === null ? {} : { parentId: pageParentId, parentType: "page" }),
          body: { representation: "atlas_doc_format", value: encodeUnknownJson(doc) },
        });
        yield* warnUnlessOk("Confluence page create rejected", result);
        if (result === null || result.status < 200 || result.status >= 300) return null;
        const page = pageRecord(result.payload);
        return page === null ? null : { id: page.id, payload: result.payload };
      });

      let parentId: string | null = null;
      for (const title of input.parentTitles) {
        const found = yield* findPage(title);
        if (found !== null) {
          parentId = found.id;
          continue;
        }
        const created: { readonly id: string; readonly payload: unknown } | null =
          yield* createPage(title, parentId, CONFLUENCE_PARENT_DOC);
        if (created !== null) {
          parentId = created.id;
          continue;
        }
        const raced = yield* findPage(title);
        if (raced === null) return null;
        parentId = raced.id;
      }

      const site = yield* loadSiteBase(input.issueKey);
      const browse = (payload: unknown, pageId: string) => {
        const fromLinks = confluenceLinksUrl(linksFrom(payload), input.heading);
        if (fromLinks !== null) return fromLinks;
        if (site === null) return null;
        return confluenceBrowseUrl({
          siteBase: site,
          spaceKey: input.spaceKey,
          pageId,
          title: input.title,
          heading: input.heading,
        });
      };
      const stored = (payload: unknown, pageId: string): JiraStoredOverflow | null => {
        const url = browse(payload, pageId);
        if (url === null) return null;
        return { kind: "confluence", label: input.title, url };
      };

      const section = markdownToAdf(input.markdown, { platform: "confluence" });
      const append = Effect.fn("JiraAppClient.append")(function* (
        pageId: string,
        attempt: number,
      ): Effect.fn.Return<JiraStoredOverflow | null> {
        const current = yield* confluenceCall(
          "GET",
          `/api/v2/pages/${encodeURIComponent(pageId)}`,
          {
            "body-format": "atlas_doc_format",
          },
        );
        yield* warnUnlessOk("Confluence page read rejected", current);
        if (current === null || current.status < 200 || current.status >= 300) return null;
        const existing = readConfluenceAtlasDoc(readField(current.payload, "body"));
        const version = versionNumber(current.payload);
        const title = readString(current.payload, "title") ?? input.title;
        if (existing === null || version === null) {
          yield* Effect.logWarning(
            "Confluence page body was not readable; left the page unchanged",
            {
              issueKey: input.issueKey,
              pageId,
            },
          );
          return null;
        }
        const next = appendAdfSection(existing, input.heading, section);
        const parent = readString(current.payload, "parentId");
        const updated = yield* confluenceCall(
          "PUT",
          `/api/v2/pages/${encodeURIComponent(pageId)}`,
          undefined,
          {
            id: pageId,
            status: "current",
            title,
            spaceId,
            ...(parent === null ? {} : { parentId: parent, parentType: "page" }),
            body: { representation: "atlas_doc_format", value: encodeUnknownJson(next) },
            version: { number: version + 1, message: "Omegent reply" },
          },
        );
        if (updated !== null && updated.status === 409 && attempt === 0)
          return yield* append(pageId, 1);
        yield* warnUnlessOk("Confluence page update rejected", updated);
        if (updated === null || updated.status < 200 || updated.status >= 300) return null;
        return stored(updated.payload, pageId) ?? stored(current.payload, pageId);
      });

      const existingLeaf = yield* findPage(input.title);
      if (existingLeaf !== null) return yield* append(existingLeaf.id, 0);

      const initial = appendAdfSection(
        { type: "doc", version: 1, content: [] },
        input.heading,
        section,
      );
      const createdLeaf: { readonly id: string; readonly payload: unknown } | null =
        yield* createPage(input.title, parentId, initial);
      if (createdLeaf !== null) {
        const url = stored(createdLeaf.payload, createdLeaf.id);
        if (url !== null) return url;
        yield* Effect.logWarning("Confluence page was created without a browse link", {
          issueKey: input.issueKey,
          pageId: createdLeaf.id,
        });
        return null;
      }
      const racedLeaf = yield* findPage(input.title);
      if (racedLeaf === null) return null;
      return yield* append(racedLeaf.id, 0);
    },
  );

  return JiraAppClient.of({
    addIssueComment,
    addCommentReaction,
    removeCommentReaction,
    addIssueAttachment,
    publishConfluenceSection,
  });
});

export const layer = Layer.effect(JiraAppClient, make);

const CONFLUENCE_PARENT_DOC: JiraAdfDoc = {
  type: "doc",
  version: 1,
  content: [
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Long Jira replies from Omegent are filed under this page.",
        },
      ],
    },
  ],
};

function readString(payload: unknown, key: string): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function readField(payload: unknown, key: string): unknown {
  if (payload === null || typeof payload !== "object") return null;
  return (payload as Record<string, unknown>)[key] ?? null;
}

function errorDetail(payload: unknown): string {
  if (typeof payload === "string") return payload.slice(0, 300);
  if (payload === null || typeof payload !== "object") return "";
  try {
    return JSON.stringify(payload).slice(0, 300);
  } catch {
    return "";
  }
}

function firstAttachment(payload: unknown): {
  readonly id: string;
  readonly filename: string | null;
  readonly content: string | null;
} | null {
  if (!Array.isArray(payload)) return null;
  const id = readString(payload[0], "id");
  if (id === null) return null;
  return {
    id,
    filename: readString(payload[0], "filename"),
    content: readString(payload[0], "content"),
  };
}

function spaceIdFromList(payload: unknown, spaceKey: string): string | null {
  if (payload === null || typeof payload !== "object") return null;
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  const wanted = spaceKey.trim().toLowerCase();
  for (const item of results) {
    const key = readString(item, "key");
    const id = readString(item, "id");
    if (id !== null && key !== null && key.toLowerCase() === wanted) return id;
  }
  return null;
}

function pagesFromList(
  payload: unknown,
): ReadonlyArray<{ readonly id: string; readonly title: string }> {
  if (payload === null || typeof payload !== "object") return [];
  const results = (payload as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  const pages: Array<{ id: string; title: string }> = [];
  for (const item of results) {
    const id = readString(item, "id");
    const title = readString(item, "title");
    if (id === null || title === null) continue;
    pages.push({ id, title });
  }
  return pages;
}

function pageRecord(payload: unknown): { readonly id: string } | null {
  const id = readString(payload, "id");
  return id === null ? null : { id };
}

function linksFrom(
  payload: unknown,
): { readonly base: string | null; readonly webui: string | null } | null {
  if (payload === null || typeof payload !== "object") return null;
  const links = (payload as { _links?: unknown })._links;
  if (links === null || typeof links !== "object") return null;
  return { base: readString(links, "base"), webui: readString(links, "webui") };
}

function versionNumber(payload: unknown): number | null {
  if (payload === null || typeof payload !== "object") return null;
  const version = (payload as { version?: unknown }).version;
  if (version === null || typeof version !== "object") return null;
  const number = (version as { number?: unknown }).number;
  return typeof number === "number" && Number.isFinite(number) ? number : null;
}
