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
    }) => Effect.Effect<{ readonly id: string } | null, never>;
  }
>()("t3/jira/JiraAppClient") {}

const CommentResponse = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
});

export const make = Effect.gen(function* () {
  const config = yield* JiraAppConfig;
  const httpClient = yield* HttpClient.HttpClient;

  const addIssueComment = Effect.fn("JiraAppClient.addIssueComment")(function* (input: {
    readonly issueKey: string;
    readonly body: string;
  }) {
    if (!config.enabled) return null;

    const url = `${config.baseUrl}/rest/api/3/issue/${encodeURIComponent(input.issueKey)}/comment`;
    let request = HttpClientRequest.post(url).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader("user-agent", "t3-code-jira-bridge"),
      HttpClientRequest.bodyJsonUnsafe({ body: plainTextToAdf(input.body) }),
    );
    if (config.authMode === "bearer") {
      request = request.pipe(HttpClientRequest.bearerToken(config.apiToken));
    } else {
      const token = Buffer.from(`${config.username}:${config.apiToken}`, "utf8").toString("base64");
      request = request.pipe(HttpClientRequest.setHeader("authorization", `Basic ${token}`));
    }

    const response = yield* httpClient.execute(request).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Jira comment create request failed", {
          issueKey: input.issueKey,
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
            status: failed.status,
            detail: detail.slice(0, 500),
          });
          return null;
        }),
    });
  });

  return JiraAppClient.of({ addIssueComment });
});

export const layer = Layer.effect(JiraAppClient, make);
