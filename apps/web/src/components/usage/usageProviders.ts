import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, GrokIcon, type Icon, KimiIcon, OpenAI } from "../Icons";

/**
 * Series and table order. The chart layers the providers from a shared zero
 * baseline, so this only fixes the reading order of legends, tables and hover
 * rows; it does not decide which series sits above the others.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "grok", "kimi"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
};

/**
 * Claude's brand orange against a neutral white for Codex, with Grok and Kimi
 * on their own brand hues. All four have to stay distinguishable side by side
 * in a stacked band, so Kimi's warmer orange is kept clear of Claude's.
 */
export const PROVIDER_COLOR: Record<UsageProviderKind, string> = {
  claude: "#d97757",
  codex: "#e6e6e6",
  grok: "#8b8b8b",
  kimi: "#ff6a3d",
};

/**
 * Brand marks, reused from the provider picker.
 *
 * These ship their own fills (`#d97757` for Claude, white on dark for OpenAI),
 * which are the same colours as the chart bands, so swapping a colour dot for a
 * mark keeps the series association intact rather than trading it away.
 */
export const PROVIDER_MARK: Record<UsageProviderKind, Icon> = {
  claude: ClaudeAI,
  codex: OpenAI,
  grok: GrokIcon,
  kimi: KimiIcon,
};
