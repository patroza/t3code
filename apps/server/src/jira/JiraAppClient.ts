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
       * Only top-level comments accept children; nest under the thread root when the
       * user wrote inside an existing reply thread.
       */
      readonly parentCommentId?: string | null;
      /**
       * Second parent to try if `parentCommentId` is rejected (e.g. root vs mention).
       * Keeps the reply inline when the first parentId is invalid.
       */
      readonly fallbackParentCommentId?: string | null;
    }) => Effect.Effect<{ readonly id: string } | null, never>;
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

  const addIssueComment = Effect.fn("JiraAppClient.addIssueComment")(function* (input: {
    readonly issueKey: string;
    readonly body: string;
    readonly parentCommentId?: string | null;
    readonly fallbackParentCommentId?: string | null;
  }) {
    if (!config.enabled) return null;

    const url = `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`;
    const adfBody = plainTextToAdf(input.body);

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
        Effect.map((parsed) => ({ id: String(parsed.id) })),
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
      | { readonly _tag: "ok"; readonly id: string }
      | { readonly _tag: "retry_next" }
      | { readonly _tag: "failed" };

    const tryPost = (parentCommentId: string | null): Effect.Effect<Attempt> =>
      Effect.gen(function* () {
        const payload: Record<string, unknown> = { body: adfBody };
        // Undocumented but supported on Jira Cloud: parentId threads under a root comment.
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
                  : ({ _tag: "ok", id: parsed.id } as const),
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
    // Prefer inline reply: primary parent → optional secondary → top-level last resort only.
    const parents: Array<string | null> = [];
    if (primary !== null) parents.push(primary);
    if (secondary !== null && secondary !== primary) parents.push(secondary);
    parents.push(null);

    for (const parent of parents) {
      const result = yield* tryPost(parent);
      if (result._tag === "ok") return { id: result.id };
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
