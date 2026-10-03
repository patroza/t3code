import { describe, expect, it } from "@effect/vitest";

import { resolveIdentityClaimCandidate } from "./identityClaimCandidate";

describe("resolveIdentityClaimCandidate", () => {
  const candidates = [{ environmentId: "first" }, { environmentId: "second" }];

  it("advances through candidates without wrapping after the final candidate", () => {
    expect(resolveIdentityClaimCandidate(candidates, 0)).toBe(candidates[0]);
    expect(resolveIdentityClaimCandidate(candidates, 1)).toBe(candidates[1]);
    expect(resolveIdentityClaimCandidate(candidates, 2)).toBeUndefined();
  });
});
