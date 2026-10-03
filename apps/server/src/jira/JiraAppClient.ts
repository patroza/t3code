import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { JiraAppConfig } from "./JiraAppConfig.ts";
import { plainTextToAdf } from "./JiraWebhookPayload.ts";

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
  const resolveThreadRootCommentId = (
    issueKey: string,
    commentId: string,
  ): Effect.Effect<string | null> =>
    Effect.gen(function* () {
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
        orElse: (failed) =>
          Effect.gen(function* () {
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
    });

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
    const adfBody = plainTextToAdf(input.body, {
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

    const tryPost = (parentCommentId: string | null): Effect.Effect<Attempt> =>
      Effect.gen(function* () {
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
          orElse: (failed) =>
            Effect.gen(function* () {
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
        orElse: (failed) =>
          Effect.gen(function* () {
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

  return JiraAppClient.of({ addIssueComment, addCommentReaction, removeCommentReaction });
});

export const layer = Layer.effect(JiraAppClient, make);
