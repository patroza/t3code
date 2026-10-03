import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import {
  classifyWebhookBodyFailure,
  previewWebhookBody,
  WebhookDebugLog,
  type WebhookDebugAppendInput,
} from "../webhooks/WebhookDebugLog.ts";
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
  | { readonly _tag: "invalid"; readonly reason: string }
  | { readonly _tag: "ignored"; readonly reason: string }
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
    if (payload === null) {
      const failure = classifyWebhookBodyFailure(body);
      return {
        _tag: "invalid",
        reason: failure.detail ? `${failure.reason}: ${failure.detail}` : failure.reason,
      };
    }
    const invocation = parseGitHubPrInvocation(payload, mention);
    return invocation === null
      ? { _tag: "ignored", reason: `no_invocation event=${event} mention=${mention}` }
      : { _tag: "invocation", invocation };
  }
  if (event === "pull_request_review_comment") {
    const payload = (() => {
      try {
        return decodeReviewComment(body);
      } catch {
        return null;
      }
    })();
    if (payload === null) {
      const failure = classifyWebhookBodyFailure(body);
      return {
        _tag: "invalid",
        reason: failure.detail ? `${failure.reason}: ${failure.detail}` : failure.reason,
      };
    }
    const invocation = parseGitHubReviewCommentInvocation(payload, mention);
    return invocation === null
      ? { _tag: "ignored", reason: `no_invocation event=${event} mention=${mention}` }
      : { _tag: "invocation", invocation };
  }
  return { _tag: "ignored", reason: `unsupported_event=${event}` };
}

export const githubWebhookRouteLayer = HttpRouter.add(
  "POST",
  GITHUB_WEBHOOK_PATH,
  Effect.gen(function* () {
    const config = yield* GitHubAppConfig;
    const debugLog = yield* WebhookDebugLog;

    const logDebug = (input: Omit<WebhookDebugAppendInput, "source">) =>
      debugLog.append({ ...input, source: "github" }).pipe(Effect.ignore, Effect.forkDetach);

    if (!config.enabled) {
      yield* logDebug({
        outcome: "disabled_404",
        status: 404,
        reason: "github_app_disabled",
        bodyBytes: 0,
      });
      return HttpServerResponse.empty({ status: 404 });
    }

    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    const { bodyBytes, bodyPreview } = previewWebhookBody(body);

    if (bodyBytes > MAX_WEBHOOK_BODY_BYTES) {
      yield* logDebug({
        outcome: "too_large_413",
        status: 413,
        reason: `bodyBytes=${bodyBytes}`,
        bodyBytes,
      });
      return HttpServerResponse.text("Payload Too Large", { status: 413 });
    }
    if (
      !verifyGitHubWebhookSignature({
        secret: config.webhookSecret,
        body,
        signature: request.headers["x-hub-signature-256"],
      })
    ) {
      yield* logDebug({
        outcome: "unauthorized_401",
        status: 401,
        reason: "signature_mismatch",
        bodyBytes,
        bodyPreview,
        mention: config.mention,
      });
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const deliveryId = request.headers["x-github-delivery"]?.trim();
    const event = request.headers["x-github-event"]?.trim();
    if (!deliveryId) {
      yield* logDebug({
        outcome: "missing_delivery_id_400",
        status: 400,
        reason: "missing_x_github_delivery",
        bodyBytes,
        bodyPreview,
        ...(event !== undefined ? { webhookEvent: event } : {}),
        mention: config.mention,
      });
      return HttpServerResponse.text("Missing delivery id", { status: 400 });
    }
    if (event !== "issue_comment" && event !== "pull_request_review_comment") {
      yield* logDebug({
        outcome: "ignored_202",
        status: 202,
        reason: `unsupported_event=${event ?? ""}`,
        bodyBytes,
        deliveryId,
        ...(event !== undefined ? { webhookEvent: event } : {}),
        mention: config.mention,
      });
      return HttpServerResponse.empty({ status: 202 });
    }

    const parsed = parseWebhook(event, body, config.mention);
    if (parsed._tag === "invalid") {
      yield* Effect.logWarning("GitHub webhook invalid payload", {
        deliveryId,
        event,
        reason: parsed.reason,
        bodyBytes,
      });
      yield* logDebug({
        outcome: "invalid_400",
        status: 400,
        reason: parsed.reason,
        bodyBytes,
        bodyPreview,
        deliveryId,
        ...(event !== undefined ? { webhookEvent: event } : {}),
        mention: config.mention,
      });
      return HttpServerResponse.text("Invalid payload", { status: 400 });
    }
    if (parsed._tag === "ignored") {
      yield* logDebug({
        outcome: "ignored_202",
        status: 202,
        reason: parsed.reason,
        bodyBytes,
        bodyPreview,
        deliveryId,
        ...(event !== undefined ? { webhookEvent: event } : {}),
        mention: config.mention,
      });
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
      yield* logDebug({
        outcome: "repo_denied_202",
        status: 202,
        reason: `repo_not_allowed=${invocation.repository}`,
        bodyBytes,
        deliveryId,
        ...(event !== undefined ? { webhookEvent: event } : {}),
        repository: invocation.repository,
        pullRequestNumber: invocation.pullRequestNumber,
        commentSurface: invocation.commentSurface,
        mention: config.mention,
      });
      return HttpServerResponse.empty({ status: 202 });
    }

    yield* logDebug({
      outcome: "accepted_202",
      status: 202,
      bodyBytes,
      deliveryId,
      ...(event !== undefined ? { webhookEvent: event } : {}),
      repository: invocation.repository,
      pullRequestNumber: invocation.pullRequestNumber,
      commentSurface: invocation.commentSurface,
      mention: config.mention,
    });

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
