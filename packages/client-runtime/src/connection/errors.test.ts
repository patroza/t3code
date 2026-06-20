import { describe, expect, it } from "@effect/vitest";

import { mapRemoteEnvironmentError } from "./errors.ts";
import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "../rpc/http.ts";

describe("connection error mapping", () => {
  it("keeps transport diagnostics structured and redacted", () => {
    const transportCause = new Error("sensitive transport implementation detail");
    const requestUrl =
      "https://environment-user:environment-password@environment.example.test/private/session?access_token=environment-secret#environment-fragment";
    const source = RemoteEnvironmentAuthFetchError.fromRequestUrl(requestUrl, transportCause);

    const error = mapRemoteEnvironmentError(source);

    expect(source.message).toBe(
      `Failed to fetch remote environment endpoint at host environment.example.test (${requestUrl.length} URL characters).`,
    );
    expect(source.message).not.toContain(transportCause.message);
    expect(error).toMatchObject({
      _tag: "ConnectionTransientError",
      reason: "network",
    });
    expect(source).toMatchObject({
      requestUrlInputLength: requestUrl.length,
      requestUrlProtocol: "https:",
      requestUrlHostname: "environment.example.test",
    });
    const diagnostics = JSON.stringify(source);
    for (const secret of [
      "environment-user",
      "environment-password",
      "/private/session",
      "environment-secret",
      "environment-fragment",
    ]) {
      expect(diagnostics).not.toContain(secret);
      expect(source.message).not.toContain(secret);
    }
  });

  it("keeps undeclared status diagnostics structured and redacted", () => {
    const cause = new Error("upstream response metadata");
    const requestUrl =
      "https://environment-user:environment-password@environment.example.test/private/session?access_token=environment-secret#environment-fragment";
    const error = RemoteEnvironmentAuthUndeclaredStatusError.fromRequestUrl(requestUrl, 502, cause);

    expect(error).toMatchObject({
      status: 502,
      requestUrlInputLength: requestUrl.length,
      requestUrlProtocol: "https:",
      requestUrlHostname: "environment.example.test",
    });
    expect(error).not.toHaveProperty("requestUrl");
  });
});
