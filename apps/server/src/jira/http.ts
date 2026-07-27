import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { JiraAppConfig, isJiraProjectAllowed } from "./JiraAppConfig.ts";
import { JiraIssueBridge } from "./JiraIssueBridge.ts";
import {
  JiraCommentWebhook,
  parseJiraCommentInvocation,
  type JiraIssueInvocation,
} from "./JiraWebhookPayload.ts";
import { verifyJiraWebhookSecret } from "./JiraWebhookSecurity.ts";

export const JIRA_WEBHOOK_PATH = "/api/jira/webhook";
const MAX_WEBHOOK_BODY_BYTES = 1_024 * 1_024;
const decodeCommentWebhook = Schema.decodeUnknownSync(Schema.fromJsonString(JiraCommentWebhook));

type ParsedWebhook =
  | { readonly _tag: "invalid" }
  | { readonly _tag: "ignored" }
  | { readonly _tag: "invocation"; readonly invocation: JiraIssueInvocation };

function parseWebhook(body: string, mention: string, botAccountId: string | null): ParsedWebhook {
  const payload = (() => {
    try {
      return decodeCommentWebhook(body);
    } catch {
      return null;
    }
  })();
  if (payload === null) return { _tag: "invalid" };

  // Accept missing webhookEvent (some Automation deliveries omit it) when a comment is present.
  const event = payload.webhookEvent?.trim().toLowerCase();
  if (event !== undefined && event !== "comment_created") {
    return { _tag: "ignored" };
  }

  const invocation = parseJiraCommentInvocation(payload, mention, { botAccountId });
  return invocation === null ? { _tag: "ignored" } : { _tag: "invocation", invocation };
}

function deliveryIdFor(
  invocation: JiraIssueInvocation,
  headerDeliveryId: string | undefined,
): string {
  if (headerDeliveryId && headerDeliveryId.trim().length > 0) {
    return headerDeliveryId.trim();
  }
  // Stable per comment so redeliveries dedupe.
  return `jira-comment:${invocation.issueKey}:${invocation.commentId}`;
}

export const jiraWebhookRouteLayer = HttpRouter.add(
  "POST",
  JIRA_WEBHOOK_PATH,
  Effect.gen(function* () {
    const config = yield* JiraAppConfig;
    if (!config.enabled) return HttpServerResponse.empty({ status: 404 });

    const request = yield* HttpServerRequest.HttpServerRequest;
    const body = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
    if (new TextEncoder().encode(body).byteLength > MAX_WEBHOOK_BODY_BYTES) {
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
      return HttpServerResponse.text("Unauthorized", { status: 401 });
    }

    const parsed = parseWebhook(body, config.mention, config.botAccountId);
    if (parsed._tag === "invalid") {
      return HttpServerResponse.text("Invalid payload", { status: 400 });
    }
    if (parsed._tag === "ignored") {
      return HttpServerResponse.empty({ status: 202 });
    }

    const { invocation } = parsed;
    if (!isJiraProjectAllowed(config.allowedProjects, invocation.projectKey)) {
      yield* Effect.logWarning("Ignoring Jira webhook from unauthorized project", {
        issueKey: invocation.issueKey,
        projectKey: invocation.projectKey,
      });
      return HttpServerResponse.empty({ status: 202 });
    }

    const headerDeliveryId =
      request.headers["x-atlassian-webhook-identifier"] ??
      request.headers["x-request-id"] ??
      undefined;
    const deliveryId = deliveryIdFor(invocation, headerDeliveryId);

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
