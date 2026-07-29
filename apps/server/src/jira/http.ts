import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { JiraAppConfig, isJiraProjectAllowed } from "./JiraAppConfig.ts";
import { JiraIssueBridge } from "./JiraIssueBridge.ts";
import {
  classifyWebhookBodyFailure,
  JiraWebhookDebugLog,
  previewWebhookBody,
  type JiraWebhookDebugAppendInput,
} from "./JiraWebhookDebugLog.ts";
import {
  isAcceptedJiraCommentEvent,
  jiraDeliveryIdFor,
  JiraCommentWebhook,
  parseJiraCommentInvocation,
  type JiraIssueInvocation,
} from "./JiraWebhookPayload.ts";
import { verifyJiraWebhookSecret } from "./JiraWebhookSecurity.ts";

export const JIRA_WEBHOOK_PATH = "/api/jira/webhook";
const MAX_WEBHOOK_BODY_BYTES = 1_024 * 1_024;
const decodeCommentWebhook = Schema.decodeUnknownSync(Schema.fromJsonString(JiraCommentWebhook));

type ParsedWebhook =
  | { readonly _tag: "invalid"; readonly reason: string }
  | { readonly _tag: "ignored"; readonly reason: string }
  | { readonly _tag: "invocation"; readonly invocation: JiraIssueInvocation };

function parseWebhook(body: string, mention: string, botAccountId: string | null): ParsedWebhook {
  const payload = (() => {
    try {
      return decodeCommentWebhook(body);
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

  // Accept missing webhookEvent (Automation often omits it). Allow created + updated.
  if (!isAcceptedJiraCommentEvent(payload.webhookEvent)) {
    return {
      _tag: "ignored",
      reason: `unsupported_webhook_event=${payload.webhookEvent ?? ""}`,
    };
  }

  const invocation = parseJiraCommentInvocation(payload, mention, { botAccountId });
  if (invocation === null) {
    return {
      _tag: "ignored",
      reason: `no_invocation mention=${mention} issue=${payload.issue.key}`,
    };
  }
  return { _tag: "invocation", invocation };
}

export const jiraWebhookRouteLayer = HttpRouter.add(
  "POST",
  JIRA_WEBHOOK_PATH,
  Effect.gen(function* () {
    const config = yield* JiraAppConfig;
    const debugLog = yield* JiraWebhookDebugLog;

    const logDebug = (input: JiraWebhookDebugAppendInput) =>
      debugLog.append(input).pipe(Effect.ignore, Effect.forkDetach);

    if (!config.enabled) {
      yield* logDebug({
        outcome: "disabled_404",
        status: 404,
        reason: `missing=${config.missing.join(",")}`,
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
      !verifyJiraWebhookSecret({
        secret: config.webhookSecret,
        authorizationHeader: request.headers["authorization"],
        t3SecretHeader: request.headers["x-t3-webhook-secret"],
        body,
        signatureHeader: request.headers["x-hub-signature-256"],
      })
    ) {
      yield* logDebug({
        outcome: "unauthorized_401",
        status: 401,
        reason: "secret_mismatch",
        bodyBytes,
        bodyPreview,
        mention: config.mention,
      });
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const parsed = parseWebhook(body, config.mention, config.botAccountId);
    if (parsed._tag === "invalid") {
      yield* Effect.logWarning("Jira webhook invalid payload", {
        reason: parsed.reason,
        bodyBytes,
      });
      yield* logDebug({
        outcome: "invalid_400",
        status: 400,
        reason: parsed.reason,
        bodyBytes,
        bodyPreview,
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
        mention: config.mention,
      });
      return HttpServerResponse.empty({ status: 202 });
    }

    const { invocation } = parsed;
    if (!isJiraProjectAllowed(config.allowedProjects, invocation.projectKey)) {
      yield* Effect.logWarning("Ignoring Jira webhook from unauthorized project", {
        issueKey: invocation.issueKey,
        projectKey: invocation.projectKey,
      });
      yield* logDebug({
        outcome: "project_denied_202",
        status: 202,
        reason: `project_not_allowed=${invocation.projectKey}`,
        bodyBytes,
        issueKey: invocation.issueKey,
        projectKey: invocation.projectKey,
        webhookEvent: invocation.webhookEvent,
        commentId: invocation.commentId,
        mention: config.mention,
      });
      return HttpServerResponse.empty({ status: 202 });
    }

    const headerDeliveryId =
      request.headers["x-atlassian-webhook-identifier"] ??
      request.headers["x-request-id"] ??
      undefined;
    const deliveryId = jiraDeliveryIdFor({ invocation, headerDeliveryId });

    yield* logDebug({
      outcome: "accepted_202",
      status: 202,
      bodyBytes,
      deliveryId,
      issueKey: invocation.issueKey,
      projectKey: invocation.projectKey,
      webhookEvent: invocation.webhookEvent,
      commentId: invocation.commentId,
      prompt: invocation.prompt.slice(0, 500),
      commentText: invocation.commentText.slice(0, 500),
      actorDisplayName: invocation.actorDisplayName,
      actorAccountId: invocation.actorAccountId,
      mention: config.mention,
    });

    const bridge = yield* JiraIssueBridge;
    yield* Effect.forkDetach(
      bridge.handle({ deliveryId, invocation }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Jira webhook delivery failed", {
            deliveryId,
            issueKey: invocation.issueKey,
            commentSurface: invocation.commentSurface,
            cause,
          }),
        ),
      ),
    );

    return HttpServerResponse.empty({ status: 202 });
  }),
);
