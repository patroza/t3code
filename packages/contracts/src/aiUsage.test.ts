import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { AI_USAGE_UNAVAILABLE, AiUsageProviderStatus, AiUsageSnapshot } from "./aiUsage.ts";

const decodeStatus = Schema.decodeUnknownSync(AiUsageProviderStatus);
const decodeSnapshot = Schema.decodeUnknownSync(AiUsageSnapshot);

describe("AiUsageProviderStatus", () => {
  it("decodes a percent provider with pace", () => {
    const status = decodeStatus({
      provider: "codex",
      ok: true,
      plan: "prolite",
      headline: "100%",
      headline_label: "5-hour",
      state: "critical",
      score: 0,
      stale: false,
      stale_since: null,
      error: null,
      windows: [
        {
          id: "5h",
          label: "5-hour",
          percent: 100,
          used: null,
          unit: null,
          resets_at: 1783369185,
          pace: {
            expected_percent: 96,
            delta_percent: 4,
            projected_percent: 105,
            eta_seconds: 0,
            lasts_to_reset: false,
            stage: "onTrack",
          },
        },
      ],
    });
    expect(status.provider).toBe("codex");
    expect(status.windows[0]?.percent).toBe(100);
    expect(status.windows[0]?.pace?.lasts_to_reset).toBe(false);
  });

  it("decodes a dollar-based window without percent", () => {
    const status = decodeStatus({
      provider: "opencode",
      ok: true,
      plan: "go",
      windows: [{ id: "weekly", label: "Weekly ($)", used: 3.01, unit: "$", percent: 10 }],
    });
    expect(status.windows[0]?.unit).toBe("$");
    expect(status.plan).toBe("go");
  });

  it("ignores unknown extra keys from the daemon feed", () => {
    const status = decodeStatus({
      provider: "zai",
      ok: true,
      windows: [],
      raw: { anything: true },
    });
    expect(status.provider).toBe("zai");
  });
});

describe("AiUsageSnapshot", () => {
  it("round-trips a multi-provider snapshot", () => {
    const snapshot = decodeSnapshot({
      generated_at: "2026-07-06T20:07:11.894Z",
      worst_percent: 100,
      available: true,
      items: [
        { provider: "claude", ok: true, windows: [{ id: "weekly", label: "Weekly", percent: 84 }] },
        { provider: "codex", ok: true, windows: [{ id: "5h", label: "5-hour", percent: 100 }] },
      ],
    });
    expect(snapshot.items).toHaveLength(2);
    expect(snapshot.available).toBe(true);
  });

  it("decodes the unavailable sentinel", () => {
    expect(decodeSnapshot(AI_USAGE_UNAVAILABLE)).toEqual(AI_USAGE_UNAVAILABLE);
  });
});
