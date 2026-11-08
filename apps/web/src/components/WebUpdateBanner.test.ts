import { describe, expect, it } from "vite-plus/test";

import { isWebUpdateAvailable } from "./WebUpdateBanner";

describe("isWebUpdateAvailable", () => {
  it("is false until both a boot and a latest version are known", () => {
    expect(isWebUpdateAvailable(null, null)).toBe(false);
    expect(isWebUpdateAvailable(null, "v1")).toBe(false);
    expect(isWebUpdateAvailable("v1", null)).toBe(false);
  });

  it("is false while the served version matches what the tab booted with", () => {
    expect(isWebUpdateAvailable("v1", "v1")).toBe(false);
  });

  it("is true once the server serves a different bundle than the tab booted with", () => {
    expect(isWebUpdateAvailable("v1", "v2")).toBe(true);
  });
});
