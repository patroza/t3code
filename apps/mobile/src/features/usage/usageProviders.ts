import type { UsageProviderKind } from "@t3tools/contracts";
import { useColorScheme } from "react-native";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex", "claude", "grok", "kimi"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  claude: "Claude Code",
  codex: "Codex",
  grok: "Grok",
  kimi: "Kimi",
};

/**
 * Claude's and Kimi's brand oranges hold in both themes; Codex and Grok are
 * neutral and must flip with the theme or their bars vanish against the
 * matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const scheme = useColorScheme();
  const dark = scheme === "dark";
  return {
    claude: "#d97757",
    codex: dark ? "#e6e6e6" : "#3c3c43",
    grok: dark ? "#8b8b8b" : "#6b6b6b",
    kimi: "#ff6a3d",
  };
}
