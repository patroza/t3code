import {
  RelayAuthInvalidError,
  RelayEnvironmentConnectNotAuthorizedError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import {
  DPOP_CLOCK_HINT,
  DPOP_RETRY_HINT,
  DPOP_UNKNOWN_HINT,
  relayProtectedErrorMessage,
} from "./errorPresentation.ts";

describe("relayProtectedErrorMessage", () => {
  it("presents clock skew as one possible cause when the relay omits the reason", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_UNKNOWN_HINT}`,
    );
  });

  it("keeps the clock hint for a relay that confirms a time-window failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "time_window",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toContain(DPOP_CLOCK_HINT);
  });

  it("does not blame the clock when the relay identifies another proof failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "key_mismatch",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_RETRY_HINT}`,
    );
  });

  it("preserves the existing message for other authentication failures", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_bearer",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe("Relay rejected the cloud session token.");
  });

  it("explains a missing environment link instead of a credential failure", () => {
    const error = new RelayEnvironmentConnectNotAuthorizedError({
      code: "environment_connect_not_authorized",
      reason: "environment_link_not_found",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      "Relay has no active link for this environment. The environment server may not have re-established its link yet.",
    );
  });

  it("still decodes a not-authorized error from a relay that omits the reason", () => {
    const error = new RelayEnvironmentConnectNotAuthorizedError({
      code: "environment_connect_not_authorized",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      "Relay rejected the environment connection request.",
    );
  });
});
