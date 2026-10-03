import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildOwnershipPredicate, type OwnershipFilterableThread } from "./ownershipFilter";

const environmentId = EnvironmentId.make("environment-local");
const me = "person-me";
const them = "person-them";
const claims: ReadonlyMap<string, string | null | undefined> = new Map([[environmentId, me]]);

function thread(
  originPersonId: string | null,
  participantPersonIds: readonly string[] = [],
): OwnershipFilterableThread {
  return {
    environmentId,
    originSource: { personId: originPersonId },
    participantSummaries: participantPersonIds.map((personId) => ({ personId })),
  };
}

describe("buildOwnershipPredicate", () => {
  it("keeps only my threads under mine", () => {
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "mine",
      relation: "both",
    });

    expect(predicate(thread(me))).toBe(true);
    expect(predicate(thread(them, [me]))).toBe(true);
    expect(predicate(thread(them))).toBe(false);
  });

  it("keeps only other people's threads under theirs", () => {
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "theirs",
      relation: "both",
    });

    expect(predicate(thread(them))).toBe(true);
    expect(predicate(thread(me))).toBe(false);
  });

  it("keeps everything under any", () => {
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "any",
      relation: "both",
    });

    expect(predicate(thread(me))).toBe(true);
    expect(predicate(thread(them))).toBe(true);
  });

  it("honours the created-only relation", () => {
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "mine",
      relation: "created",
    });

    expect(predicate(thread(me))).toBe(true);
    // Participating is not creating.
    expect(predicate(thread(them, [me]))).toBe(false);
  });

  it("reads attributed work as someone else's when the environment has no claim", () => {
    // An environment with no identity claim (smart has no map while t3vm does)
    // cannot match anyone, so attributed threads fall to Theirs.
    const mine = buildOwnershipPredicate({
      claimPersonIdByEnvironment: undefined,
      mode: "mine",
      relation: "both",
    });
    const theirs = buildOwnershipPredicate({
      claimPersonIdByEnvironment: undefined,
      mode: "theirs",
      relation: "both",
    });

    expect(mine(thread(them))).toBe(false);
    expect(theirs(thread(them))).toBe(true);
  });

  it("keeps fully unattributed threads under mine", () => {
    // Local work carries no person at all; hiding it under the default filter
    // would empty the board for anyone not using identity claims.
    const predicate = buildOwnershipPredicate({
      claimPersonIdByEnvironment: claims,
      mode: "mine",
      relation: "both",
    });

    expect(predicate(thread(null))).toBe(true);
  });
});
