import { ConnectionBlockedError } from "@t3tools/client-runtime/connection";
import {
  EnvironmentAuthInvalidError,
  EnvironmentOperationForbiddenError,
  EnvironmentScopeRequiredError,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  T3AuthenticationError,
  formatPairingError,
  isActionableConnectionError,
  isAuthenticationError,
  isConnectionBlockedError,
  isEnvironmentAuthInvalidError,
  selectCandidateFailure,
} from "./connectionErrors.ts";

describe("T3AuthenticationError", () => {
  it("formats missing_credential with pairing instructions and no em-dash", () => {
    const err = new T3AuthenticationError({
      reason: "missing_credential",
      endpoint: "http://127.0.0.1:3773/",
      serverLabel: "Workstation",
    });

    expect(err.name).toBe("T3AuthenticationError");
    expect(err.reason).toBe("missing_credential");
    expect(err.endpoint).toBe("http://127.0.0.1:3773/");
    expect(err.serverLabel).toBe("Workstation");
    expect(err.message).toBe(
      'T3 Code at Workstation (http://127.0.0.1:3773/) requires pairing. Run "T3 Code: Pair with Server…" with a pairing URL or token from T3 Code (Settings → Sharing & access, or t3 pair).',
    );
    expect(err.message).not.toContain("—");
  });

  it("formats invalid_credential with re-pairing instructions and preserves cause", () => {
    const rootCause = new Error("HTTP 401");
    const err = new T3AuthenticationError({
      reason: "invalid_credential",
      endpoint: "https://t3.example/",
      serverLabel: "Remote Host",
      cause: rootCause,
    });

    expect(err.name).toBe("T3AuthenticationError");
    expect(err.reason).toBe("invalid_credential");
    expect(err.endpoint).toBe("https://t3.example/");
    expect(err.serverLabel).toBe("Remote Host");
    expect(err.cause).toBe(rootCause);
    expect(err.message).toBe(
      'T3 Code at Remote Host (https://t3.example/) rejected this client\'s credentials. Run "T3 Code: Pair with Server…" to pair again.',
    );
    expect(err.message).not.toContain("—");
  });
});

describe("connection error predicates", () => {
  it("unwraps cause chains and guards against cyclic causes", () => {
    const authErr = new T3AuthenticationError({
      reason: "missing_credential",
      endpoint: "http://127.0.0.1:3773/",
      serverLabel: "Desktop",
    });
    const wrappedAuth = new Error("outer", { cause: authErr });
    expect(isAuthenticationError(authErr)).toBe(true);
    expect(isAuthenticationError(wrappedAuth)).toBe(true);
    expect(isActionableConnectionError(wrappedAuth)).toBe(true);

    const cyclicA: { cause?: unknown } = {};
    const cyclicB: { cause?: unknown } = { cause: cyclicA };
    cyclicA.cause = cyclicB;
    expect(isAuthenticationError(cyclicA)).toBe(false);
    expect(isConnectionBlockedError(cyclicA)).toBe(false);
    expect(isEnvironmentAuthInvalidError(cyclicA)).toBe(false);
    expect(isActionableConnectionError(cyclicA)).toBe(false);
  });
});

describe("selectCandidateFailure", () => {
  it("prefers auth-required error on desktop over fetch failed on fallback configured endpoint", () => {
    const authErr = new T3AuthenticationError({
      reason: "missing_credential",
      endpoint: "http://127.0.0.1:3773/",
      serverLabel: "Desktop",
    });
    const networkErr = new TypeError("fetch failed");

    expect(selectCandidateFailure([authErr, networkErr])).toBe(authErr);
  });

  it("prefers ConnectionBlockedError on paired endpoint over fetch failed on desktop/configured", () => {
    const blockedErr = new ConnectionBlockedError({
      reason: "unsupported",
      detail: "Update T3 Code on Remote to connect.",
    });
    const desktopErr = new TypeError("fetch failed");
    const configuredErr = new Error("connect ECONNREFUSED 127.0.0.1:3773");

    expect(selectCandidateFailure([blockedErr, desktopErr, configuredErr])).toBe(blockedErr);
  });

  it("prefers auth-required error on configured endpoint over ECONNREFUSED on stale desktop", () => {
    const staleDesktopErr = new Error("connect ECONNREFUSED 127.0.0.1:49999");
    const configuredAuthErr = new T3AuthenticationError({
      reason: "missing_credential",
      endpoint: "http://127.0.0.1:3773/",
      serverLabel: "Configured",
    });

    expect(selectCandidateFailure([staleDesktopErr, configuredAuthErr])).toBe(configuredAuthErr);
  });

  it("falls back to the first error when all failures are generic network errors", () => {
    const first = new Error("connect ECONNREFUSED 127.0.0.1:4000");
    const second = new TypeError("fetch failed");

    expect(selectCandidateFailure([first, second])).toBe(first);
    const empty = selectCandidateFailure([]);
    expect(empty).toBeInstanceOf(Error);
    expect((empty as Error).message).toBe("No T3 Code server endpoint is available.");
  });
});

describe("formatPairingError", () => {
  it("preserves T3AuthenticationError, ConnectionBlockedError, and EnvironmentHttp error messages verbatim", () => {
    const authErr = new T3AuthenticationError({
      reason: "invalid_credential",
      endpoint: "http://127.0.0.1:3773/",
      serverLabel: "Desktop",
    });
    expect(formatPairingError(authErr)).toBe(authErr.message);
    expect(formatPairingError(new Error("wrapped", { cause: authErr }))).toBe(authErr.message);

    const blockedErr = new ConnectionBlockedError({
      reason: "unsupported",
      detail: "This client requires a newer server. Update T3 Code on Host to connect.",
    });
    expect(formatPairingError(blockedErr)).toBe(blockedErr.message);

    const envAuthErr = new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "trace-1",
    });
    expect(formatPairingError(envAuthErr)).toBe(envAuthErr.message);

    const scopeErr = new EnvironmentScopeRequiredError({
      code: "insufficient_scope",
      requiredScope: "orchestration:read",
      traceId: "trace-2",
    });
    expect(formatPairingError(scopeErr)).toBe(scopeErr.message);

    const forbiddenErr = new EnvironmentOperationForbiddenError({
      code: "operation_forbidden",
      reason: "current_session_revoke_not_allowed",
      traceId: "trace-3",
    });
    expect(formatPairingError(forbiddenErr)).toBe(forbiddenErr.message);
  });

  it("formats generic errors and non-error values cleanly", () => {
    expect(formatPairingError(new Error("Connection timed out"))).toBe("Connection timed out");
    expect(formatPairingError("plain string error")).toBe("plain string error");
  });
});
