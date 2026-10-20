import { resolveRemotePairingTarget } from "@t3tools/shared/remote";
import { describe, expect, it } from "vite-plus/test";

import { classifyPairingInput, describeTokenExpiry } from "./pairing.ts";

const FALLBACK_SERVER_URL = "http://127.0.0.1:3773";

describe("classifyPairingInput", () => {
  it("treats input containing a scheme as a pairing URL", () => {
    expect(
      classifyPairingInput("http://127.0.0.1:3773/pair#token=abc123", FALLBACK_SERVER_URL),
    ).toEqual({ kind: "url", pairingUrl: "http://127.0.0.1:3773/pair#token=abc123" });
  });

  it("trims surrounding whitespace from a pairing URL", () => {
    expect(
      classifyPairingInput("  https://t3.example/pair#token=xyz  ", FALLBACK_SERVER_URL),
    ).toEqual({ kind: "url", pairingUrl: "https://t3.example/pair#token=xyz" });
  });

  it("treats a bare token as a pairing code against the fallback host", () => {
    expect(classifyPairingInput("pair-token-123", FALLBACK_SERVER_URL)).toEqual({
      kind: "code",
      host: FALLBACK_SERVER_URL,
      pairingCode: "pair-token-123",
    });
  });

  it("throws on empty or whitespace-only input", () => {
    expect(() => classifyPairingInput("", FALLBACK_SERVER_URL)).toThrow(
      "Enter a pairing URL or pairing token.",
    );
    expect(() => classifyPairingInput("   \n\t ", FALLBACK_SERVER_URL)).toThrow(
      "Enter a pairing URL or pairing token.",
    );
  });
});

describe("describeTokenExpiry", () => {
  it("describes multi-day expiries in days", () => {
    expect(describeTokenExpiry(2_592_000)).toBe("~30 days");
    expect(describeTokenExpiry(86_400)).toBe("~1 days");
  });

  it("describes sub-day expiries in hours", () => {
    expect(describeTokenExpiry(18_000)).toBe("~5 hours");
    expect(describeTokenExpiry(3_600)).toBe("~1 hours");
  });

  it("describes sub-hour expiries in minutes", () => {
    expect(describeTokenExpiry(300)).toBe("~5 minutes");
  });

  it("clamps very short or invalid expiries", () => {
    expect(describeTokenExpiry(30)).toBe("~1 minute");
    expect(describeTokenExpiry(0)).toBe("unknown duration");
    expect(describeTokenExpiry(-5)).toBe("unknown duration");
    expect(describeTokenExpiry(Number.NaN)).toBe("unknown duration");
  });
});

describe("classifyPairingInput composed with resolveRemotePairingTarget", () => {
  it("resolves a pairing URL to a credential and base URLs", () => {
    const classified = classifyPairingInput(
      "http://127.0.0.1:3773/pair#token=abc123",
      FALLBACK_SERVER_URL,
    );
    const resolved =
      classified.kind === "url"
        ? resolveRemotePairingTarget({ pairingUrl: classified.pairingUrl })
        : resolveRemotePairingTarget({
            host: classified.host,
            pairingCode: classified.pairingCode,
          });
    expect(resolved).toEqual({
      credential: "abc123",
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });
  });

  it("resolves a bare token against the fallback host", () => {
    const classified = classifyPairingInput("abc123", FALLBACK_SERVER_URL);
    const resolved =
      classified.kind === "url"
        ? resolveRemotePairingTarget({ pairingUrl: classified.pairingUrl })
        : resolveRemotePairingTarget({
            host: classified.host,
            pairingCode: classified.pairingCode,
          });
    expect(resolved).toEqual({
      credential: "abc123",
      httpBaseUrl: "http://127.0.0.1:3773/",
      wsBaseUrl: "ws://127.0.0.1:3773/",
    });
  });
});
