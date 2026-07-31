import { describe, expect, it } from "vite-plus/test";

import { shouldSettleAfterServerRestart } from "./OrphanSessionRecovery.ts";

describe("OrphanSessionRecovery", () => {
  it("gives a live auto-woken provider process precedence over orphan settlement", () => {
    expect(
      shouldSettleAfterServerRestart({
        claimsLive: true,
        hasLiveProcess: true,
      }),
    ).toBe(false);
  });

  it("settles a persisted live claim when no provider process exists", () => {
    expect(
      shouldSettleAfterServerRestart({
        claimsLive: true,
        hasLiveProcess: false,
      }),
    ).toBe(true);
  });
});
