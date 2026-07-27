import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { JiraAppConfig } from "./JiraAppConfig.ts";
import { markdownishToAdf } from "./JiraWebhookPayload.ts";

export class JiraAppClient extends Context.Service<
  JiraAppClient,
  {
    readonly addIssueComment: (input: {
      readonly issueKey: string;
      readonly body: string;
      /** When set, try to post as a threaded reply under this comment id. */
      readonly parentCommentId?: string | null;
    }) => Effect.Effect<{ readonly id: string } | null, never>;
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

  const postOnce = Effect.fn("JiraAppClient.postOnce")(function* (input: {
    readonly issueKey: string;
    readonly body: string;
    readonly parentCommentId: string | null;
  }) {
    if (!config.enabled) return null as { readonly id: string } | null;

    const url = `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`;
    const adf = markdownishToAdf(input.body);
    const payload: Record<string, unknown> = { body: adf };
    // Jira Cloud threaded replies (when enabled for the site).
    if (input.parentCommentId !== null && input.parentCommentId.trim() !== "") {
      payload.parentId = input.parentCommentId.trim();
    }

    const request = authorize(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.acceptJson,
        HttpClientRequest.setHeader("user-agent", "t3-code-jira-bridge"),
        HttpClientRequest.bodyJsonUnsafe(payload),
      ),
    );

    const response = yield* httpClient.execute(request).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Jira comment create request failed", {
          issueKey: input.issueKey,
          parentCommentId: input.parentCommentId,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );
    if (response === null) return null;

    return yield* HttpClientResponse.matchStatus(response, {
      "2xx": (success) =>
        HttpClientResponse.schemaBodyJson(CommentResponse)(success).pipe(
          Effect.map((parsed) => ({ id: String(parsed.id) })),
          Effect.tapError((cause) =>
            Effect.logWarning("Jira comment create response decode failed", {
              issueKey: input.issueKey,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => null),
        ),
      orElse: (failed) =>
        Effect.gen(function* () {
          const detail = yield* failed.text.pipe(Effect.orElseSucceed(() => ""));
          yield* Effect.logWarning("Jira comment create rejected", {
            issueKey: input.issueKey,
            parentCommentId: input.parentCommentId,
            status: failed.status,
            detail: detail.slice(0, 500),
          });
          return null;
        }),
    });
  });

  const addIssueComment = Effect.fn("JiraAppClient.addIssueComment")(function* (input: {
    readonly issueKey: string;
    readonly body: string;
    readonly parentCommentId?: string | null;
  }) {
    const parent =
      input.parentCommentId !== undefined && input.parentCommentId !== null
        ? input.parentCommentId.trim()
        : "";
    const parentId = parent.length > 0 ? parent : null;

    const withParent = yield* postOnce({
      issueKey: input.issueKey,
      body: input.body,
      parentCommentId: parentId,
    });
    if (withParent !== null || parentId === null) return withParent;

    // Site may not support threaded replies — fall back to a top-level comment.
    yield* Effect.logInfo("Jira parent reply unsupported; posting top-level comment", {
      issueKey: input.issueKey,
      parentCommentId: parentId,
    });
    return yield* postOnce({
      issueKey: input.issueKey,
      body: input.body,
      parentCommentId: null,
    });
  });

  return JiraAppClient.of({ addIssueComment });
});

export const layer = Layer.effect(JiraAppClient, make);
