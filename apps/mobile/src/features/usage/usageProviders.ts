import type { UsageProviderKind } from "@t3tools/contracts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
export const PROVIDER_ORDER = [
  "codex",
  "claude",
  "grok",
  "kimi",
  "cursor",
  "opencode",
  "antigravity",
] as const satisfies readonly UsageProviderKind[];

/**
 * A provider added to `UsageProviderKind` but not to {@link PROVIDER_ORDER}
 * would still appear in the summary rows (those come from `merged.providers`)
 * while silently vanishing from the daily columns, chart bands, legends and
 * skeletons, all of which iterate this order. The `Record` maps below are
 * exhaustive by their own type; this makes the order exhaustive too, so the
 * omission is a compile error rather than a missing column nobody notices.
 */
type AssertNoUnorderedProvider<T extends never> = T;
export type UsageProviderOrderIsExhaustive = AssertNoUnorderedProvider<
  Exclude<UsageProviderKind, (typeof PROVIDER_ORDER)[number]>
>;

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  kimi: "Kimi",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
};

/**
 * Claude's and Kimi's brand oranges hold in both themes; Codex and Grok are
 * neutrals and must flip with the theme or their bars vanish against the
 * matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const { themeAppearance: scheme } = useAppearancePreferences();
  const dark = scheme === "dark";
  return {
    claude: "#d97757",
    codex: dark ? "#e6e6e6" : "#3c3c43",
    grok: dark ? "#a1a1aa" : "#52525b",
    kimi: "#ff6a3d",
    cursor: "#8b8b8b",
    opencode: "#5b9bbd",
    antigravity: "#8c7bd1",
  };
}

/**
 * Neutral steps for cost and token mixes, so they never borrow a provider's
 * color. Matches the web steps: oklab mixes of the codex ink into the
 * background, above the 15 ΔE separation floor for adjacent segments.
 */
export function useUsageMixColors() {
  const { themeAppearance: scheme } = useAppearancePreferences();
  const dark = scheme === "dark";
  return {
    input: dark ? "#737373" : "#848484",
    cacheRead: dark ? "#282828" : "#c0c0c0",
    cacheWrite: dark ? "#949494" : "#6d6d6d",
    output: dark ? "#e6e6e6" : "#3c3c43",
    other: dark ? "#494949" : "#a3a3a3",
    standard: dark ? "#313131" : "#b8b8b8",
    fast: dark ? "#838383" : "#797979",
    ultrafast: dark ? "#e6e6e6" : "#3c3c43",
  };
}
