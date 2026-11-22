import { describe, expect, it } from "vite-plus/test";

import { isCommandReadinessExemptPath } from "./commandReadinessExemption.ts";

describe("isCommandReadinessExemptPath", () => {
  it.each([
    ["/oauth/token", true],
    ["/oauth/token?grant_type=refresh_token", true],
    ["/.well-known/t3/environment#x", true],
    ["/oauth/token/extra", false],
    ["/ws", false],
    ["/api/orchestration/threads", false],
  ])("%s -> %s", (url, exempt) => {
    expect(isCommandReadinessExemptPath(url)).toBe(exempt);
  });
});
