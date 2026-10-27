import { describe, expect, it } from "vite-plus/test";

import { PROVIDER_ORDER } from "./usageProviders";
import { buildPeriodColumns, chartScale, niceScale } from "./UsageProviderChart";

describe("chartScale", () => {
  const column = (codex: number) => ({
    total: codex,
    bands: [{ provider: "codex" as const, value: codex }],
  });

  it("holds unlabeled placeholder gridlines while loading providers have nothing to show", () => {
    const scale = chartScale([column(0)], new Set(["codex" as const]));

    expect(scale.labeled).toBe(false);
    expect(scale.ticks.length).toBeGreaterThan(1);
  });

  it("scales to what is on screen, loading or not", () => {
    expect(chartScale([column(40)], new Set(["codex" as const]))).toMatchObject({
      max: 40,
      labeled: true,
    });
  });
});

describe("niceScale", () => {
  it("never puts the peak above the top of the scale", () => {
    for (const peak of [1122.71, 999, 1, 0.04, 1_400_000_000, 37.5, 5000, 100.001]) {
      const { max } = niceScale(peak, 4);
      expect(max, `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it("starts at zero and ends at the maximum", () => {
    const { max, ticks } = niceScale(1122.71, 4);

    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(max, 6);
  });

  it("uses evenly spaced 1/2/5 steps", () => {
    const { ticks } = niceScale(1122.71, 4);
    const steps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));

    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
    const [first = 0] = steps;
    const normalized = first / 10 ** Math.floor(Math.log10(first));
    expect([1, 2, 5, 10]).toContain(Math.round(normalized));
  });

  it("keeps the tick count near the requested resolution", () => {
    const { ticks } = niceScale(1122.71, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it("degrades to a single zero tick with no data", () => {
    expect(niceScale(0, 4)).toEqual({ max: 0, ticks: [0] });
  });
});

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 42,
        totalTokens: 420,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
          ["pi" as const, { costUsd: 5, totalTokens: 50 }],
          ["muse" as const, { costUsd: 7, totalTokens: 70 }],
        ]),
      },
    ],
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);

  it("keeps band values absolute rather than cumulative", () => {
    const [first] = buildPeriodColumns(days, byDay, "cost");

    // Only the providers this fixture has data for; asserting the full band
    // list would re-break every time a provider joins PROVIDER_ORDER, which
    // says nothing about whether the values are absolute.
    expect(first?.bands.filter((band) => band.value !== 0)).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
      { provider: "pi", value: 5 },
      { provider: "muse", value: 7 },
    ]);
    // Absolute, not cumulative: a stack offset would make the second band the
    // running total (30) rather than its own value.
    expect(first?.bands.map((band) => band.provider)).toEqual([...PROVIDER_ORDER]);
  });
});
