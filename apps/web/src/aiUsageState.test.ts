import type {
  AiUsageProviderStatus,
  AiUsageSnapshot,
  ProviderDriverKind,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  formatPaceNote,
  formatResetsIn,
  formatWindowValue,
  isEnforcedUsageWindow,
  mapDriverToUsageProvider,
  resolveDriverUsage,
  resolveDriverUsages,
  usageDotFillClass,
  usageDotRingColor,
  usageMarkerForItem,
  usageProviderLabel,
  usageProvidersForDriver,
  usageRank,
  worstUsagePercent,
} from "./aiUsageState";

const driver = (value: string) => value as ProviderDriverKind;

function status(overrides: Partial<AiUsageProviderStatus>): AiUsageProviderStatus {
  return { provider: "codex", ok: true, windows: [], ...overrides };
}

describe("mapDriverToUsageProvider", () => {
  it("maps known drivers to daemon provider slugs", () => {
    expect(mapDriverToUsageProvider(driver("claudeAgent"), null)).toBe("claude");
    expect(mapDriverToUsageProvider(driver("codex"), null)).toBe("codex");
    expect(mapDriverToUsageProvider(driver("cursor"), null)).toBe("cursor");
    expect(mapDriverToUsageProvider(driver("grok"), null)).toBe("grok");
    expect(mapDriverToUsageProvider(driver("opencode"), "gpt-oss")).toBe("opencode");
  });

  it("routes zai coding-plan models under opencode to zai, else opencode-go", () => {
    expect(mapDriverToUsageProvider(driver("opencode"), "zai-coding-plan/glm-5.2")).toBe("zai");
    expect(mapDriverToUsageProvider(driver("opencode"), undefined)).toBe("opencode");
    expect(mapDriverToUsageProvider(driver("opencode"), "gpt-oss")).toBe("opencode");
  });

  it("returns null for drivers with no usage feed", () => {
    expect(mapDriverToUsageProvider(null, null)).toBeNull();
    expect(mapDriverToUsageProvider(driver("some-fork-driver"), null)).toBeNull();
  });
});

describe("usageMarkerForItem", () => {
  it("fills critical when any window is maxed", () => {
    expect(
      usageMarkerForItem(status({ windows: [{ id: "5h", label: "5h", percent: 100 }] })).fill,
    ).toBe("critical");
    // A maxed weekly is a hard block even when the 5-hour bucket is fresh.
    expect(
      usageMarkerForItem(
        status({
          windows: [
            { id: "5h", label: "5h", percent: 0 },
            { id: "weekly", label: "Weekly", percent: 100 },
          ],
        }),
      ).fill,
    ).toBe("critical");
  });

  it("fills warn when the immediate window crosses the threshold", () => {
    expect(
      usageMarkerForItem(status({ windows: [{ id: "5h", label: "5h", percent: 82 }] })).fill,
    ).toBe("warn");
  });

  it("does NOT fill from a weekly pace overshoot when the 5-hour window is fresh", () => {
    const marker = usageMarkerForItem(
      status({
        windows: [
          { id: "5h", label: "5-hour", percent: 0 },
          {
            id: "weekly",
            label: "Weekly",
            percent: 68,
            pace: { lasts_to_reset: false, delta_percent: 36 },
          },
        ],
      }),
    );
    expect(marker.fill).toBe("none");
    expect(marker.outlookAtRisk).toBe(true);
  });

  it("flags a filling weekly window as an outlook risk without escalating fill", () => {
    const marker = usageMarkerForItem(
      status({
        windows: [
          { id: "5h", label: "5h", percent: 32 },
          { id: "weekly", label: "Weekly", percent: 84 },
        ],
      }),
    );
    expect(marker.fill).toBe("none");
    expect(marker.outlookAtRisk).toBe(true);
  });

  it("is quiet when comfortably under and on pace", () => {
    expect(
      usageMarkerForItem(
        status({
          windows: [
            {
              id: "5h",
              label: "5h",
              percent: 20,
              pace: { lasts_to_reset: true, delta_percent: -5 },
            },
          ],
        }),
      ),
    ).toEqual({ fill: "none", outlookAtRisk: false });
  });

  it("does not go critical from a drained extra-usage pool (real claude/max feed)", () => {
    // The daemon reports the extra-usage buffer as a `monthly` window; it is
    // only drawn from once 5h/weekly run out, so 100% there is not a limit.
    const marker = usageMarkerForItem(
      status({
        provider: "claude",
        windows: [
          { id: "5h", label: "5-hour", percent: 18 },
          { id: "weekly", label: "Weekly", percent: 78 },
          { id: "monthly", label: "Extra usage (off)", percent: 100, used: 47.89, unit: "€" },
        ],
      }),
    );
    expect(marker.fill).toBe("none");
    // Weekly at 78% is still just an outlook concern, not a block.
    expect(marker.outlookAtRisk).toBe(true);
  });

  it("ignores daemon-flagged informational pools for fill and outlook", () => {
    const marker = usageMarkerForItem(
      status({
        provider: "grok",
        windows: [
          { id: "weekly", label: "Weekly SuperGrok Heavy", percent: 12 },
          {
            id: "monthly",
            label: "Monthly (legacy $)",
            percent: 100,
            unit: "$",
            informational: true,
            pace: { lasts_to_reset: false, delta_percent: 1 },
          },
        ],
      }),
    );
    expect(marker).toEqual({ fill: "none", outlookAtRisk: false });
  });

  it("still goes critical when a real plan window is maxed alongside extras", () => {
    expect(
      usageMarkerForItem(
        status({
          windows: [
            { id: "5h", label: "5-hour", percent: 100 },
            { id: "monthly", label: "Extra usage (off)", percent: 100 },
          ],
        }),
      ).fill,
    ).toBe("critical");
  });

  it("keeps enforcing money-denominated plan windows", () => {
    // opencode-go / cursor bill in $ or requests — those monthly windows are
    // the plan, not a buffer behind it.
    expect(
      usageMarkerForItem(
        status({
          provider: "cursor",
          windows: [{ id: "monthly", label: "Monthly (billing cycle)", percent: 100, unit: "req" }],
        }),
      ).fill,
    ).toBe("critical");
  });

  it("is quiet when the provider is not ok", () => {
    expect(
      usageMarkerForItem(status({ ok: false, windows: [{ id: "5h", label: "5h", percent: 100 }] })),
    ).toEqual({ fill: "none", outlookAtRisk: false });
  });
});

describe("worstUsagePercent", () => {
  it("returns the max across windows, ignoring non-numeric", () => {
    expect(
      worstUsagePercent(
        status({
          windows: [
            { id: "5h", label: "5h", percent: 32 },
            { id: "weekly", label: "Weekly", percent: 84 },
            { id: "extra", label: "Extra", percent: null },
          ],
        }),
      ),
    ).toBe(84);
  });

  it("skips spend pools so a drained extras buffer is not the worst window", () => {
    expect(
      worstUsagePercent(
        status({
          windows: [
            { id: "5h", label: "5-hour", percent: 18 },
            { id: "monthly", label: "Extra usage (off)", percent: 100 },
          ],
        }),
      ),
    ).toBe(18);
  });
});

describe("isEnforcedUsageWindow", () => {
  it("treats extra-usage / credit / on-demand buffers and off windows as context", () => {
    for (const label of [
      "Extra usage (off)",
      "Extra usage",
      "Credits",
      "On-demand ($)",
      "Pay as you go",
      "Weekly (off)",
    ]) {
      expect(isEnforcedUsageWindow({ id: "monthly", label })).toBe(false);
    }
    expect(
      isEnforcedUsageWindow({ id: "monthly", label: "Monthly (legacy $)", informational: true }),
    ).toBe(false);
  });

  it("treats real plan windows as enforced", () => {
    for (const label of ["5-hour", "Weekly", "Monthly ($)", "Monthly (billing cycle)"]) {
      expect(isEnforcedUsageWindow({ id: "weekly", label })).toBe(true);
    }
  });
});

describe("resolveDriverUsage + usageRank", () => {
  const snapshot: AiUsageSnapshot = {
    generated_at: null,
    worst_percent: 100,
    available: true,
    items: [
      status({ provider: "claude", windows: [{ id: "weekly", label: "Weekly", percent: 84 }] }),
      status({ provider: "codex", windows: [{ id: "5h", label: "5h", percent: 100 }] }),
    ],
  };

  it("resolves the item + marker for a mapped driver", () => {
    const usage = resolveDriverUsage(snapshot, driver("codex"), null);
    expect(usage?.provider).toBe("codex");
    expect(usage?.marker.fill).toBe("critical");
  });

  it("returns null for unmapped drivers", () => {
    expect(resolveDriverUsage(snapshot, driver("some-unknown"), null)).toBeNull();
  });

  it("ranks by the daemon's item order, trailing unknowns", () => {
    expect(usageRank(snapshot, driver("claudeAgent"), null)).toBe(0);
    expect(usageRank(snapshot, driver("codex"), null)).toBe(1);
    expect(usageRank(snapshot, driver("some-unknown"), null)).toBe(Number.POSITIVE_INFINITY);
  });

  it("returns null / infinity when the snapshot is unavailable", () => {
    const down: AiUsageSnapshot = {
      generated_at: null,
      worst_percent: null,
      available: false,
      items: [],
    };
    expect(resolveDriverUsage(down, driver("codex"), null)).toBeNull();
    expect(usageRank(down, driver("codex"), null)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("opencode hosts opencode-go + z.ai", () => {
  const snapshot: AiUsageSnapshot = {
    generated_at: null,
    worst_percent: 100,
    available: true,
    items: [
      status({
        provider: "opencode",
        windows: [{ id: "weekly", label: "Weekly ($)", percent: 10 }],
      }),
      status({ provider: "zai", windows: [{ id: "5h", label: "5-hour", percent: 100 }] }),
    ],
  };

  it("lists both providers for the opencode driver", () => {
    expect(usageProvidersForDriver(driver("opencode"))).toEqual(["opencode", "zai"]);
    expect(usageProvidersForDriver(driver("codex"))).toEqual(["codex"]);
    expect(usageProvidersForDriver(driver("grok"))).toEqual(["grok"]);
  });

  it("resolves both hosted providers present in the snapshot", () => {
    const usages = resolveDriverUsages(snapshot, driver("opencode"));
    expect(usages.map((u) => u.provider)).toEqual(["opencode", "zai"]);
    expect(usages[1]?.marker.fill).toBe("critical");
  });

  it("single-resolve honours the active model: z.ai overrides go", () => {
    expect(
      resolveDriverUsage(snapshot, driver("opencode"), "zai-coding-plan/glm-5.2")?.provider,
    ).toBe("zai");
    expect(resolveDriverUsage(snapshot, driver("opencode"), "gpt-oss")?.provider).toBe("opencode");
  });

  it("labels providers for display", () => {
    expect(usageProviderLabel("zai")).toBe("z.ai");
    expect(usageProviderLabel("opencode")).toBe("OpenCode");
    expect(usageProviderLabel("grok")).toBe("Grok");
    expect(usageProviderLabel("codex")).toBe("Codex");
  });
});

describe("usageDotFillClass + usageDotRingColor", () => {
  it("maps fill to background tokens", () => {
    expect(usageDotFillClass({ fill: "critical", outlookAtRisk: false })).toBe("bg-destructive");
    expect(usageDotFillClass({ fill: "warn", outlookAtRisk: false })).toBe("bg-warning");
    expect(usageDotFillClass({ fill: "none", outlookAtRisk: false })).toBeUndefined();
  });

  it("uses a neutral dot + ring when only the outlook is at risk", () => {
    const marker = { fill: "none", outlookAtRisk: true } as const;
    expect(usageDotFillClass(marker)).toBe("bg-muted-foreground/70");
    expect(usageDotRingColor(marker)).toBe("var(--warning)");
  });

  it("has no ring when the outlook is fine", () => {
    expect(usageDotRingColor({ fill: "warn", outlookAtRisk: false })).toBeUndefined();
  });
});

describe("formatting", () => {
  it("formats reset-in from epoch seconds", () => {
    const now = 1_000_000_000_000; // ms
    const nowSec = now / 1000;
    expect(formatResetsIn(nowSec + 3600 * 2 + 60 * 5, now)).toBe("2h 5m");
    expect(formatResetsIn(nowSec + 60 * 45, now)).toBe("45m");
    expect(formatResetsIn(nowSec - 10, now)).toBe("resetting");
    expect(formatResetsIn(null, now)).toBeNull();
  });

  it("formats window values by unit", () => {
    expect(formatWindowValue({ id: "5h", label: "5h", percent: 84 })).toBe("84%");
    expect(formatWindowValue({ id: "od", label: "On-demand", used: 3.5, unit: "$" })).toBe("$3.50");
    expect(formatWindowValue({ id: "t", label: "Tokens", used: 1200, unit: "tok" })).toBe(
      "1200 tok",
    );
    expect(formatWindowValue({ id: "x", label: "x" })).toBe("—");
  });

  it("formats a runs-out pace note", () => {
    expect(
      formatPaceNote({
        id: "weekly",
        label: "Weekly",
        percent: 68,
        pace: { lasts_to_reset: false, eta_seconds: 7200, delta_percent: 37 },
      }),
    ).toBe("runs out in 2h 0m · +37% vs pace");
  });

  it("returns null for an on-pace window", () => {
    expect(
      formatPaceNote({
        id: "5h",
        label: "5h",
        percent: 20,
        pace: { lasts_to_reset: true, delta_percent: 2 },
      }),
    ).toBeNull();
  });
});
