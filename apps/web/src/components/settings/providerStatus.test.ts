import { describe, expect, it } from "vitest";

import { getProviderCompatibilityAdvisoryPresentation } from "./providerStatus";

describe("getProviderCompatibilityAdvisoryPresentation", () => {
  it("hides supported compatibility advisories", () => {
    expect(
      getProviderCompatibilityAdvisoryPresentation({
        status: "supported",
        severity: "info",
        currentVersion: "0.129.0",
        message: null,
        recommendedRange: ">=0.129.0",
        ranges: [],
      }),
    ).toBeNull();
  });

  it("presents broken compatibility advisories strongly", () => {
    expect(
      getProviderCompatibilityAdvisoryPresentation({
        status: "broken",
        severity: "error",
        currentVersion: "0.128.0",
        message: "Known incompatible.",
        recommendedRange: ">=0.129.0",
        ranges: [],
      }),
    ).toEqual({
      title: "Incompatible provider version",
      detail: "Known incompatible.",
      emphasis: "strong",
    });
  });
});
