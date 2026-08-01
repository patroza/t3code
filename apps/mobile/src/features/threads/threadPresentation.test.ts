import { describe, expect, it } from "vite-plus/test";

import { resolveSettledRowTimestamp } from "./threadPresentation";

const base = {
  settledAt: null as string | null,
  latestUserMessageAt: null as string | null,
  updatedAt: "2026-01-01T00:00:00.000Z",
  createdAt: "2025-12-01T00:00:00.000Z",
};

describe("resolveSettledRowTimestamp", () => {
  it("prefers the explicit settle stamp", () => {
    expect(
      resolveSettledRowTimestamp({
        ...base,
        settledAt: "2026-02-02T00:00:00.000Z",
        latestUserMessageAt: "2026-01-15T00:00:00.000Z",
      }),
    ).toBe("2026-02-02T00:00:00.000Z");
  });

  it("falls back to last user activity for auto-settled threads", () => {
    expect(
      resolveSettledRowTimestamp({ ...base, latestUserMessageAt: "2026-01-15T00:00:00.000Z" }),
    ).toBe("2026-01-15T00:00:00.000Z");
  });

  it("falls back to updatedAt when the thread has no user message", () => {
    expect(resolveSettledRowTimestamp(base)).toBe("2026-01-01T00:00:00.000Z");
  });

  it("orders rows the same way the settled shelf sorts them", () => {
    // The shelf sorts by settledAt ?? latestUserMessageAt ?? updatedAt, so a
    // freshly settled old thread must label ahead of a stale newer one.
    const settledRecently = {
      ...base,
      settledAt: "2026-03-01T00:00:00.000Z",
      latestUserMessageAt: "2025-06-01T00:00:00.000Z",
    };
    const touchedRecently = { ...base, latestUserMessageAt: "2026-02-01T00:00:00.000Z" };

    expect(
      Date.parse(resolveSettledRowTimestamp(settledRecently)) >
        Date.parse(resolveSettledRowTimestamp(touchedRecently)),
    ).toBe(true);
  });
});
