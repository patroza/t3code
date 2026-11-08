import { describe, expect, it } from "vite-plus/test";

import {
  detectServerCapabilities,
  FORK_SERVER_CAPABILITIES,
  UPSTREAM_SERVER_CAPABILITIES,
} from "./serverCompatibility.ts";

describe("detectServerCapabilities", () => {
  it("enables fork-only surfaces when the compatibility probe succeeds", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return { enabled: false };
    };

    await expect(detectServerCapabilities(probe)).resolves.toEqual(FORK_SERVER_CAPABILITIES);
    expect(calls).toBe(1);
  });

  it("keeps shared VS Code features available when an upstream server rejects the probe", async () => {
    const probe = async () => Promise.reject(new Error("method not found"));

    await expect(detectServerCapabilities(probe)).resolves.toEqual(UPSTREAM_SERVER_CAPABILITIES);
  });
});
