import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  AuthStandardClientScopes,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthRelayReadScope,
  AuthRelayWriteScope,
  AuthReviewWriteScope,
  AuthTerminalOperateScope,
  EnvironmentAuthInvalidError,
  type EnvironmentAuthInvalidReason,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  type EnvironmentInternalErrorReason,
  EnvironmentOperationForbiddenError,
  EnvironmentRequestInvalidError,
  type EnvironmentRequestInvalidReason,
  EnvironmentScopeRequiredError,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import type { AuthEnvironmentScope } from "@t3tools/contracts";
import { parseAllowedOAuthScope } from "@t3tools/shared/oauthScope";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as SessionStore from "./SessionStore.ts";
import { traceAuthenticatedRelayRequest, traceRelayRequest } from "../cloud/traceRelayRequest.ts";
import { deriveAuthClientMetadata } from "./utils.ts";
import { verifyRequestDpopProof } from "./dpop.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const MAX_FAILURE_TAG_LENGTH = 128;
const MAX_CAUSE_CHAIN_DEPTH = 32;

const EnvironmentFailureTag = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_FAILURE_TAG_LENGTH),
);

function failureLogAttributes(input: unknown) {
  const cause = Cause.isCause(input) ? input : Cause.fail(input);
  let failureCount = 0;
  let defectCount = 0;
  let interruptionCount = 0;
  for (const reason of cause.reasons) {
    switch (reason._tag) {
      case "Fail":
        failureCount += 1;
        break;
      case "Die":
        defectCount += 1;
        break;
      case "Interrupt":
        interruptionCount += 1;
        break;
    }
  }
  const unboundedFailureTag = causeErrorTag(cause).trim() || "Unknown";
  return {
    failureTag: unboundedFailureTag.slice(0, MAX_FAILURE_TAG_LENGTH),
    reasonCount: cause.reasons.length,
    failureCount,
    defectCount,
    interruptionCount,
  };
}

function findInterruptCause(input: unknown): Cause.Cause<never> | undefined {
  const seen = new Set<object>();
  let current = input;
  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH; depth += 1) {
    if (Cause.isCause(current)) {
      return Cause.hasInterruptsOnly(current) ? (current as Cause.Cause<never>) : undefined;
    }
    if (typeof current !== "object" || current === null || seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    if (!("cause" in current)) {
      return undefined;
    }
    current = current.cause;
  }
  return undefined;
}

export class EnvironmentHttpInternalError extends EnvironmentInternalError.extend<EnvironmentHttpInternalError>(
  "EnvironmentHttpInternalError",
)({
  failureTag: EnvironmentFailureTag,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Environment API operation failed (${this.reason}).`;
  }
}

const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const appendDpopChallengeHeader = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeader(response, "www-authenticate", "DPoP")),
);

const appendDpopChallengeOnUnauthorized = (error: EnvironmentAuthInvalidError) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const usesDpop =
      (request.originalUrl.startsWith("/oauth/token") && request.headers.dpop !== undefined) ||
      request.headers.authorization?.startsWith("DPoP ") === true;
    if (usesDpop) {
      yield* appendDpopChallengeHeader;
    }
    return yield* error;
  });

export const currentEnvironmentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export function annotateEnvironmentRequest(endpoint: string) {
  return Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const traceId = yield* currentEnvironmentTraceId;

    yield* Effect.addFinalizer((exit) =>
      exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)
        ? Effect.logWarning("environment api request failed", {
            endpoint,
            traceId,
            ...failureLogAttributes(exit.cause),
          })
        : Effect.void,
    );
    yield* Effect.annotateLogsScoped({ "environment.endpoint": endpoint, traceId });
    yield* Effect.annotateCurrentSpan({
      "environment.endpoint": endpoint,
      "http.request.method": request.method,
      "url.path": url._tag === "Some" ? url.value.pathname : "unknown",
    });
  });
}

export function failEnvironmentAuthInvalid(reason: EnvironmentAuthInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentAuthInvalidError({ code: "auth_invalid", reason, traceId })),
    ),
  );
}

export function failEnvironmentInvalidRequest(reason: EnvironmentRequestInvalidReason) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new EnvironmentRequestInvalidError({ code: "invalid_request", reason, traceId })),
    ),
  );
}

export function failEnvironmentScopeRequired(requiredScope: AuthEnvironmentScope) {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentScopeRequiredError({
          code: "insufficient_scope",
          requiredScope,
          traceId,
        }),
      ),
    ),
  );
}

function failEnvironmentOperationForbidden(reason: "current_session_revoke_not_allowed") {
  return currentEnvironmentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(
        new EnvironmentOperationForbiddenError({
          code: "operation_forbidden",
          reason,
          traceId,
        }),
      ),
    ),
  );
}

export const failEnvironmentInternal = Effect.fn("environment.auth.failEnvironmentInternal")(
  function* (reason: EnvironmentInternalErrorReason, cause: unknown) {
    const interruptCause = findInterruptCause(cause);
    if (interruptCause !== undefined) {
      return yield* Effect.failCause(interruptCause);
    }
    const traceId = yield* currentEnvironmentTraceId;
    const diagnostics = failureLogAttributes(cause);
    yield* Effect.logError("environment api operation failed", {
      reason,
      traceId,
      ...diagnostics,
    });
    return yield* new EnvironmentHttpInternalError({
      code: "internal_error",
      reason,
      traceId,
      failureTag: diagnostics.failureTag,
      cause,
    });
  },
);

const failAuthenticationInternal = (error: EnvironmentAuth.ServerAuthAuthenticationInternalError) =>
  failEnvironmentInternal("internal_error", error);

export const catchEnvironmentAuthenticationErrors = <A, R>(
  effect: Effect.Effect<A, EnvironmentAuth.ServerAuthAuthenticationError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      ServerAuthMissingCredentialError: () => failEnvironmentAuthInvalid("missing_credential"),
      ServerAuthInvalidCredentialError: () => failEnvironmentAuthInvalid("invalid_credential"),
      ServerAuthSessionCredentialValidationError: failAuthenticationInternal,
      ServerAuthDpopReplayStateRecordError: failAuthenticationInternal,
      ServerAuthDpopReplayKeyCalculationError: failAuthenticationInternal,
    }),
  );

export const requireEnvironmentScope = Effect.fn("environment.auth.requireScope")(function* (
  scope: AuthEnvironmentScope,
) {
  const session = yield* EnvironmentAuthenticatedPrincipal;
  if (!session.scopes.has(scope)) {
    return yield* failEnvironmentScopeRequired(scope);
  }
  return session;
});

export const environmentAuthenticatedAuthLayer = Layer.effect(
  EnvironmentAuthenticatedAuth,
  Effect.gen(function* () {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* catchEnvironmentAuthenticationErrors(
          serverAuth.authenticateHttpRequest(request),
        );
        return yield* httpEffect.pipe(
          Effect.provideService(EnvironmentAuthenticatedPrincipal, {
            ...session,
            scopes: new Set(session.scopes),
          }),
          session.subject === "cloud-connect" ? traceAuthenticatedRelayRequest : identity,
        );
      }).pipe(
        Effect.catchTags({
          EnvironmentAuthInvalidError: appendDpopChallengeOnUnauthorized,
        }),
      );
  }),
);

export const authHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;

    return handlers
      .handle(
        "session",
        Effect.fn("environment.auth.session")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            return yield* serverAuth.getSessionState(request);
          },
          Effect.catchTags({
            ServerAuthSessionCredentialValidationError: failAuthenticationInternal,
            ServerAuthDpopReplayStateRecordError: failAuthenticationInternal,
            ServerAuthDpopReplayKeyCalculationError: failAuthenticationInternal,
          }),
        ),
      )
      .handle(
        "browserSession",
        Effect.fn("environment.auth.browserSession")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const result = yield* serverAuth.createBrowserSession(
              args.payload.credential,
              deriveAuthClientMetadata({ request }),
            );
            const sessionCookies = yield* Effect.fromResult(
              Cookies.set(Cookies.empty, sessions.cookieName, result.sessionToken, {
                expires: DateTime.toDate(result.response.expiresAt),
                httpOnly: true,
                path: "/",
                sameSite: "lax",
              }),
            ).pipe(
              Effect.catchTags({
                CookieError: (cause) =>
                  failEnvironmentInternal("browser_session_cookie_failed", cause),
              }),
            );

            yield* HttpEffect.appendPreResponseHandler((_request, response) =>
              Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
            );
            yield* appendCredentialResponseHeaders;
            return result.response;
          },
          Effect.catchTags({
            ServerAuthInvalidCredentialError: () =>
              failEnvironmentAuthInvalid("invalid_credential"),
            ServerAuthBootstrapCredentialValidationError: (error) =>
              failEnvironmentInternal("browser_session_issuance_failed", error),
            ServerAuthAuthenticatedSessionIssueError: (error) =>
              failEnvironmentInternal("browser_session_issuance_failed", error),
          }),
        ),
      )
      .handle(
        "token",
        Effect.fn("environment.auth.token")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const request = yield* HttpServerRequest.HttpServerRequest;
            const requestedScopes =
              args.payload.scope === undefined
                ? undefined
                : parseAllowedOAuthScope({
                    value: args.payload.scope,
                    allowedScopes: new Set<AuthEnvironmentScope>([
                      AuthOrchestrationReadScope,
                      AuthOrchestrationOperateScope,
                      AuthTerminalOperateScope,
                      AuthReviewWriteScope,
                      AuthAccessReadScope,
                      AuthAccessWriteScope,
                      AuthRelayReadScope,
                      AuthRelayWriteScope,
                    ]),
                  });
            if (requestedScopes === null) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            const proofKeyThumbprint = args.headers.dpop
              ? yield* verifyRequestDpopProof({ request }).pipe(
                  Effect.catchTags({
                    ServerAuthInvalidCredentialError: () =>
                      appendDpopChallengeHeader.pipe(
                        Effect.andThen(failEnvironmentAuthInvalid("invalid_credential")),
                      ),
                    ServerAuthDpopReplayStateRecordError: (error) =>
                      failEnvironmentInternal("access_token_issuance_failed", error),
                    ServerAuthDpopReplayKeyCalculationError: (error) =>
                      failEnvironmentInternal("access_token_issuance_failed", error),
                  }),
                )
              : undefined;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.exchangeBootstrapCredentialForAccessToken(
              args.payload.subject_token,
              requestedScopes,
              deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.client_label ? { label: args.payload.client_label } : {}),
                  ...(args.payload.client_device_type
                    ? { deviceType: args.payload.client_device_type }
                    : {}),
                  ...(args.payload.client_os ? { os: args.payload.client_os } : {}),
                },
              }),
              proofKeyThumbprint ? { proofKeyThumbprint } : undefined,
            );
          },
          traceRelayRequest,
          Effect.catchTags({
            ServerAuthInvalidCredentialError: () =>
              failEnvironmentAuthInvalid("invalid_credential"),
            ServerAuthScopeNotGrantedError: () =>
              failEnvironmentInvalidRequest("scope_not_granted"),
            ServerAuthBootstrapCredentialValidationError: (error) =>
              failEnvironmentInternal("access_token_issuance_failed", error),
            ServerAuthAuthenticatedAccessTokenIssueError: (error) =>
              failEnvironmentInternal("access_token_issuance_failed", error),
          }),
        ),
      )
      .handle(
        "webSocketTicket",
        Effect.fn("environment.auth.webSocketTicket")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* EnvironmentAuthenticatedPrincipal;
            yield* appendCredentialResponseHeaders;
            return yield* serverAuth.issueWebSocketTicket(session);
          },
          Effect.catchTags({
            ServerAuthWebSocketTokenIssueError: (error) =>
              failEnvironmentInternal("websocket_ticket_issuance_failed", error),
          }),
        ),
      )
      .handle(
        "pairingCredential",
        Effect.fn("environment.auth.pairingCredential")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const delegatedScopes = args.payload.scopes ?? AuthStandardClientScopes;
            if (
              delegatedScopes.length === 0 ||
              new Set<AuthEnvironmentScope>(delegatedScopes).size !== delegatedScopes.length
            ) {
              return yield* failEnvironmentInvalidRequest("invalid_scope");
            }
            for (const delegatedScope of delegatedScopes) {
              if (!session.scopes.has(delegatedScope)) {
                return yield* failEnvironmentScopeRequired(delegatedScope);
              }
            }
            return yield* serverAuth.issuePairingCredential(args.payload);
          },
          Effect.catchTags({
            ServerAuthPairingLinkCreationError: (error) =>
              failEnvironmentInternal("pairing_credential_issuance_failed", error),
          }),
        ),
      )
      .handle(
        "pairingLinks",
        Effect.fn("environment.auth.pairingLinks")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listPairingLinks();
          },
          Effect.catchTags({
            ServerAuthPairingLinksListError: (error) =>
              failEnvironmentInternal("pairing_links_load_failed", error),
          }),
        ),
      )
      .handle(
        "revokePairingLink",
        Effect.fn("environment.auth.revokePairingLink")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokePairingLink(args.payload.id);
            return { revoked };
          },
          Effect.catchTags({
            ServerAuthPairingLinkRevocationError: (error) =>
              failEnvironmentInternal("pairing_link_revoke_failed", error),
          }),
        ),
      )
      .handle(
        "clients",
        Effect.fn("environment.auth.clients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessReadScope);
            return yield* serverAuth.listClientSessions(session.sessionId);
          },
          Effect.catchTags({
            ServerAuthSessionsListError: (error) =>
              failEnvironmentInternal("client_sessions_load_failed", error),
          }),
        ),
      )
      .handle(
        "revokeClient",
        Effect.fn("environment.auth.revokeClient")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revoked = yield* serverAuth.revokeClientSession(
              session.sessionId,
              args.payload.sessionId,
            );
            return { revoked };
          },
          Effect.catchTags({
            ServerAuthForbiddenOperationError: () =>
              failEnvironmentOperationForbidden("current_session_revoke_not_allowed"),
            ServerAuthSessionRevocationError: (error) =>
              failEnvironmentInternal("client_session_revoke_failed", error),
          }),
        ),
      )
      .handle(
        "revokeOtherClients",
        Effect.fn("environment.auth.revokeOtherClients")(
          function* (args) {
            yield* annotateEnvironmentRequest(args.endpoint.name);
            const session = yield* requireEnvironmentScope(AuthAccessWriteScope);
            const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
            return { revokedCount };
          },
          Effect.catchTags({
            ServerAuthOtherSessionsRevocationError: (error) =>
              failEnvironmentInternal("client_session_revoke_failed", error),
          }),
        ),
      );
  }),
);
