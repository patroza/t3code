import type { AiUsageProviderStatus } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { AiUsageStats } from "./AiUsageStats";

/**
 * The live `ai-usage` daemon shape for a claude/max plan: plenty of headroom on
 * both plan windows, with the extra-usage credit buffer drained and switched
 * off. The buffer is only drawn from once 5h/weekly run out, so it must render
 * as neutral context — not as "Claude is out".
 */
const claudeWithDrainedExtras: AiUsageProviderStatus = {
  provider: "claude",
  ok: true,
  plan: "max",
  stale: true,
  windows: [
    { id: "5h", label: "5-hour", percent: 18, resets_at: 1785874200 },
    { id: "weekly", label: "Weekly", percent: 78, resets_at: 1785895200 },
    {
      id: "monthly",
      label: "Extra usage (off)",
      percent: 100,
      used: 47.89,
      limit: 45,
      unit: "€",
      resets_at: null,
    },
  ],
};

const render = (item: AiUsageProviderStatus) =>
  renderToStaticMarkup(<AiUsageStats item={item} nowMs={1785866400_000} />);

describe("AiUsageStats", () => {
  it("does not mark the provider out of limit for a drained extra-usage pool", () => {
    const markup = render(claudeWithDrainedExtras);
    expect(markup).toContain("Extra usage (off)");
    expect(markup).not.toContain("limit reached");
    expect(markup).not.toContain("bg-destructive");
  });

  it("still reports a real maxed plan window", () => {
    const markup = render({
      ...claudeWithDrainedExtras,
      windows: [
        { id: "5h", label: "5-hour", percent: 100 },
        ...claudeWithDrainedExtras.windows.slice(1),
      ],
    });
    expect(markup).toContain("limit reached");
    expect(markup).toContain("bg-destructive");
  });
});
