import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import {
  EnvironmentAuthInvalidError,
  EnvironmentOperationForbiddenError,
  EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export type T3AuthFailureReason = "missing_credential" | "invalid_credential";

// @effect-diagnostics-next-line extendsNativeError:off - T3Client exposes native Error rejections at the VS Code extension boundary.
export class T3AuthenticationError extends Error {
  readonly reason: T3AuthFailureReason;
  readonly endpoint: string;
  readonly serverLabel: string;

  constructor(input: {
    readonly reason: T3AuthFailureReason;
    readonly endpoint: string;
    readonly serverLabel: string;
    readonly cause?: unknown;
  }) {
    const message =
      input.reason === "missing_credential"
        ? `T3 Code at ${input.serverLabel} (${input.endpoint}) requires pairing. Run "T3 Code: Pair with Server…" with a pairing URL or token from T3 Code (Settings → Sharing & access, or t3 pair).`
        : `T3 Code at ${input.serverLabel} (${input.endpoint}) rejected this client's credentials. Run "T3 Code: Pair with Server…" to pair again.`;
    super(message, ...(input.cause === undefined ? [] : [{ cause: input.cause }]));
    this.name = "T3AuthenticationError";
    this.reason = input.reason;
    this.endpoint = input.endpoint;
    this.serverLabel = input.serverLabel;
  }
}

const isDirectAuthenticationError = (cause: unknown): cause is T3AuthenticationError =>
  cause instanceof T3AuthenticationError;

const isSchemaConnectionBlockedError = Schema.is(ConnectionBlockedError);

const isDirectConnectionBlockedError = (cause: unknown): cause is ConnectionBlockedError =>
  isSchemaConnectionBlockedError(cause) ||
  (typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    cause._tag === "ConnectionBlockedError");

const isDirectEnvironmentAuthInvalidError = Schema.is(EnvironmentAuthInvalidError);
const isDirectEnvironmentScopeRequiredError = Schema.is(EnvironmentScopeRequiredError);
const isDirectEnvironmentOperationForbiddenError = Schema.is(EnvironmentOperationForbiddenError);

type ActionableConnectionError =
  | T3AuthenticationError
  | ConnectionBlockedError
  | EnvironmentAuthInvalidError
  | EnvironmentScopeRequiredError
  | EnvironmentOperationForbiddenError;

const isDirectActionableConnectionError = (cause: unknown): cause is ActionableConnectionError =>
  isDirectAuthenticationError(cause) ||
  isDirectConnectionBlockedError(cause) ||
  isDirectEnvironmentAuthInvalidError(cause) ||
  isDirectEnvironmentScopeRequiredError(cause) ||
  isDirectEnvironmentOperationForbiddenError(cause);

function findInCauseChain<T>(
  cause: unknown,
  predicate: (value: unknown) => value is T,
): T | undefined {
  const seen = new Set<unknown>();
  let current: unknown = cause;
  while (current !== undefined && current !== null && !seen.has(current)) {
    if (predicate(current)) return current;
    seen.add(current);
    current = typeof current === "object" && "cause" in current ? current.cause : undefined;
  }
  return undefined;
}

export function isAuthenticationError(cause: unknown): cause is T3AuthenticationError {
  return findInCauseChain(cause, isDirectAuthenticationError) !== undefined;
}

export function isConnectionBlockedError(cause: unknown): cause is ConnectionBlockedError {
  return findInCauseChain(cause, isDirectConnectionBlockedError) !== undefined;
}

export function isEnvironmentAuthInvalidError(
  cause: unknown,
): cause is EnvironmentAuthInvalidError {
  return findInCauseChain(cause, isDirectEnvironmentAuthInvalidError) !== undefined;
}

export function isActionableConnectionError(cause: unknown): boolean {
  return findInCauseChain(cause, isDirectActionableConnectionError) !== undefined;
}

/**
 * Prefer actionable errors (auth/pairing/protocol) from reachable endpoints over
 * generic network errors from fallback candidates.
 */
export function selectCandidateFailure(failures: ReadonlyArray<unknown>): unknown {
  return (
    failures.find((failure) => isActionableConnectionError(failure)) ??
    failures[0] ??
    new Error("No T3 Code server endpoint is available.")
  );
}

export function formatPairingError(cause: unknown): string {
  const actionable = findInCauseChain(cause, isDirectActionableConnectionError);
  if (actionable !== undefined) {
    if (typeof actionable.message === "string" && actionable.message.trim() !== "") {
      return actionable.message;
    }
    if (
      "detail" in actionable &&
      typeof actionable.detail === "string" &&
      actionable.detail.trim() !== ""
    ) {
      return actionable.detail;
    }
  }
  return cause instanceof Error && cause.message.trim() !== "" ? cause.message : String(cause);
}
