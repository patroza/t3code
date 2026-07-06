import { assert, describe, it } from "vite-plus/test";

import {
  ERROR_DETAIL_CLAMP_MIN_CHARS,
  errorDetailClampClassName,
  errorDetailShouldClamp,
} from "./errorDetailText";

describe("errorDetailShouldClamp", () => {
  it("does not clamp short messages", () => {
    assert.equal(errorDetailShouldClamp("a".repeat(ERROR_DETAIL_CLAMP_MIN_CHARS - 1)), false);
  });

  it("clamps long messages", () => {
    assert.equal(errorDetailShouldClamp("a".repeat(ERROR_DETAIL_CLAMP_MIN_CHARS)), true);
  });
});

describe("errorDetailClampClassName", () => {
  it("returns responsive clamps only when needed", () => {
    assert.equal(errorDetailClampClassName(false), undefined);
    const clampClass = errorDetailClampClassName(true);
    assert.ok(clampClass?.includes("line-clamp-4"));
    assert.ok(clampClass?.includes("sm:line-clamp-6"));
  });
});
