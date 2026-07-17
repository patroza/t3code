import { describe, expect, it } from "vite-plus/test";

import { localizeZaiResetTime } from "./providerErrorText";

// The viewer's local rendering of a China-time (UTC+8) wall clock. Computed the
// same way the implementation does, so the assertion holds in any runner zone.
function expectedLocalStamp(y: number, mo: number, d: number, h: number, mi: number, s: number) {
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, s) - 8 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

describe("localizeZaiResetTime", () => {
  it("rewrites the z.ai reset timestamp from UTC+8 to local time", () => {
    const message = "Usage limit reached for 5 hour. Your limit will reset at 2026-07-07 19:49:44";
    const result = localizeZaiResetTime(message);
    expect(result).toContain(`limit will reset at ${expectedLocalStamp(2026, 7, 7, 19, 49, 44)}`);
    expect(result.startsWith("Usage limit reached for 5 hour.")).toBe(true);
  });

  it("leaves unrelated messages untouched", () => {
    expect(localizeZaiResetTime("You've hit your usage limit.")).toBe(
      "You've hit your usage limit.",
    );
    expect(localizeZaiResetTime("")).toBe("");
  });

  it("only fires on the z.ai 'limit will reset at' wording", () => {
    const other = "Rate limit resets at 2026-07-07 19:49:44";
    expect(localizeZaiResetTime(other)).toBe(other);
  });
});
