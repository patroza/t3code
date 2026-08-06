import { assert, describe, it } from "@effect/vitest";

import { shouldPreserveServerDistEntry } from "./serverDistClean.ts";

describe("shouldPreserveServerDistEntry", () => {
  it("keeps the live client tree and promote staging dirs", () => {
    assert.isTrue(shouldPreserveServerDistEntry("client"));
    assert.isTrue(shouldPreserveServerDistEntry("client.prev"));
    assert.isTrue(shouldPreserveServerDistEntry("client.next.abc123"));
  });

  it("allows pack outputs to be removed", () => {
    assert.isFalse(shouldPreserveServerDistEntry("bin.mjs"));
    assert.isFalse(shouldPreserveServerDistEntry("bin.mjs.map"));
    assert.isFalse(shouldPreserveServerDistEntry("service-launcher.mjs"));
    assert.isFalse(shouldPreserveServerDistEntry("NodePtyAdapter-abc.mjs"));
  });
});
