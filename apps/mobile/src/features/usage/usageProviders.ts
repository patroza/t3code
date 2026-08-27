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
  };
}
