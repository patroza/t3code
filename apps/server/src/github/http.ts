import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { GitHubAppConfig } from "./GitHubAppConfig.ts";
import { GitHubPrBridge, isGitHubRepositoryAllowed } from "./GitHubPrBridge.ts";
import {
  GitHubIssueCommentWebhook,
  GitHubPullRequestReviewCommentWebhook,
  type GitHubPrInvocation,
  parseGitHubPrInvocation,
  parseGitHubReviewCommentInvocation,
} from "./GitHubWebhookPayload.ts";
import { verifyGitHubWebhookSignature } from "./GitHubWebhookSecurity.ts";

export const GITHUB_WEBHOOK_PATH = "/api/github/webhook";
const MAX_WEBHOOK_BODY_BYTES = 1_024 * 1_024;
const decodeIssueComment = Schema.decodeUnknownSync(
  Schema.fromJsonString(GitHubIssueCommentWebhook),
);
const decodeReviewComment = Schema.decodeUnknownSync(
  Schema.fromJsonString(GitHubPullRequestReviewCommentWebhook),
);

type ParsedWebhook =
  | { readonly _tag: "invalid" }
  | { readonly _tag: "ignored" }
  | { readonly _tag: "invocation"; readonly invocation: GitHubPrInvocation };

function parseWebhook(event: string, body: string, mention: string): ParsedWebhook {
  if (event === "issue_comment") {
    const payload = (() => {
      try {
        return decodeIssueComment(body);
      } catch {
        return null;
      }
    })();
    if (payload === null) return { _tag: "invalid" };
    const invocation = parseGitHubPrInvocation(payload, mention);
    return invocation === null ? { _tag: "ignored" } : { _tag: "invocation", invocation };
  }
  if (event === "pull_request_review_comment") {
    const payload = (() => {
      try {
        return decodeReviewComment(body);
      } catch {
        return null;
      }
    })();
    if (payload === null) return { _tag: "invalid" };
    const invocation = parseGitHubReviewCommentInvocation(payload, mention);
    return invocation === null ? { _tag: "ignored" } : { _tag: "invocation", invocation };
  }
  return { _tag: "ignored" };
}

export const githubWebhookRouteLayer = HttpRouter.add(
  "POST",
  GITHUB_WEBHOOK_PATH,
  Effect.gen(function* () {
    const config = yield* GitHubAppConfig;
    if (!config.enabled) return HttpServerResponse.empty({ status: 404 });

    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BODY_BYTES) {
      return HttpServerResponse.text("Payload Too Large", { status: 413 });
    }
    if (
      !verifyGitHubWebhookSignature({
        secret: config.webhookSecret,
        body,
        signature: request.headers["x-hub-signature-256"],
      })
    ) {
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const deliveryId = request.headers["x-github-delivery"]?.trim();
    const event = request.headers["x-github-event"]?.trim();
    if (!deliveryId) return HttpServerResponse.text("Missing delivery id", { status: 400 });
    if (event !== "issue_comment" && event !== "pull_request_review_comment") {
      return HttpServerResponse.empty({ status: 202 });
    }

    const parsed = parseWebhook(event, body, config.mention);
    if (parsed._tag === "invalid") {
      return HttpServerResponse.text("Invalid payload", { status: 400 });
    }
    if (parsed._tag === "ignored") {
      return HttpServerResponse.empty({ status: 202 });
    }
    const { invocation } = parsed;
    if (!isGitHubRepositoryAllowed(config.allowedRepositories, invocation.repository)) {
      yield* Effect.logWarning("Ignoring GitHub webhook from unauthorized repository", {
        deliveryId,
        installationId: invocation.installationId,
        repository: invocation.repository,
        pullRequestNumber: invocation.pullRequestNumber,
        commentSurface: invocation.commentSurface,
      });
      return HttpServerResponse.empty({ status: 202 });
    }

    const bridge = yield* GitHubPrBridge;
    yield* Effect.forkDetach(
      bridge.handle({ deliveryId, invocation }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("GitHub webhook delivery failed", {
            deliveryId,
            repository: invocation.repository,
            pullRequestNumber: invocation.pullRequestNumber,
            commentSurface: invocation.commentSurface,
            cause,
          }),
        ),
      ),
    );
    return HttpServerResponse.empty({ status: 202 });
  }),
);

export const disabledGithubWebhookRouteLayer = Layer.empty;
