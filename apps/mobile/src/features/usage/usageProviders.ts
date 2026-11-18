import type { UsageProviderKind } from "@t3tools/contracts";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { providerColors } from "./providerColors";

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
  "pi",
  "muse",
] as const satisfies readonly UsageProviderKind[];

/** Every usage provider must have a chart position, or its summary would lack matching chart data. */
type AssertNoUnorderedProvider<T extends never> = T;
export type UsageProviderOrderIsExhaustive = AssertNoUnorderedProvider<
  Exclude<UsageProviderKind, (typeof PROVIDER_ORDER)[number]>
>;

export function usageProviderKind(driver: string): UsageProviderKind | null {
  if (driver === "claudeAgent") return "claude";
  return PROVIDER_ORDER.find((kind) => kind === driver) ?? null;
}

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok Build",
  kimi: "Kimi",
  cursor: "Cursor",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  pi: "Pi",
  muse: "Muse Code",
};

export function useProviderColors(): Record<UsageProviderKind, string> {
  return providerColors(useAppearancePreferences().themeAppearance);
}

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
