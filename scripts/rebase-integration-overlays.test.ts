import { describe, expect, it } from "vite-plus/test";

import {
  assertOverlaysReadyForCompose,
  planOverlayRebase,
  type OverlayRebaseResult,
} from "./rebase-integration-overlays.ts";
import { StackError } from "./rebase-pr-stack.ts";

describe("planOverlayRebase", () => {
  it("skips when fork/changes is already an ancestor of the overlay tip", () => {
    expect(
      planOverlayRebase({
        number: 173,
        branch: "fork/desktop",
        tip: "tip1",
        newBase: "base1",
        isNewBaseAncestorOfTip: true,
        mergeBaseWithNewBase: "base1",
      }),
    ).toMatchObject({ action: "skip-already-based" });
  });

  it("plans a rebase using the merge-base with the new changes tip", () => {
    expect(
      planOverlayRebase({
        number: 174,
        branch: "fork/discord",
        tip: "tip2",
        newBase: "base2",
        isNewBaseAncestorOfTip: false,
        mergeBaseWithNewBase: "oldBase2",
      }),
    ).toEqual({
      number: 174,
      branch: "fork/discord",
      tip: "tip2",
      newBase: "base2",
      oldBase: "oldBase2",
      action: "rebase",
    });
  });

  it("errors when there is no usable merge-base", () => {
    expect(
      planOverlayRebase({
        number: 175,
        branch: "fork/vscode",
        tip: "tip3",
        newBase: "base3",
        isNewBaseAncestorOfTip: false,
        mergeBaseWithNewBase: null,
      }).action,
    ).toBe("error");
  });
});

describe("assertOverlaysReadyForCompose", () => {
  it("accepts already-based skips", () => {
    const result: OverlayRebaseResult = {
      updated: [],
      skipped: [
        {
          number: 173,
          branch: "fork/desktop",
          reason: "already based on fork/changes",
        },
      ],
      conflicts: [],
    };
    expect(() => assertOverlaysReadyForCompose(result, "fork/changes")).not.toThrow();
  });

  it("throws on conflicts", () => {
    const result: OverlayRebaseResult = {
      updated: [],
      skipped: [],
      conflicts: [{ number: 174, branch: "fork/discord", message: "conflict: apps/x.ts" }],
    };
    expect(() => assertOverlaysReadyForCompose(result, "fork/changes")).toThrow(StackError);
    expect(() => assertOverlaysReadyForCompose(result, "fork/changes")).toThrow(/174/);
  });
});
