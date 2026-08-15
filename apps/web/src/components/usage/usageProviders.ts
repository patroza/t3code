import type { UsageProviderKind } from "@t3tools/contracts";

import { ClaudeAI, GrokIcon, type Icon, KimiIcon, OpenAI } from "../Icons";

type UsageProviderPresentation = {
  readonly label: string;
  readonly color: string;
  readonly mark: Icon;
};

/**
 * Exhaustive presentation for providers supported by the usage contract.
 * Declaration order is reused by every chart, table, legend, and skeleton, so
 * adding a provider only requires its contract support and one entry here.
 *
 * All four have to stay distinguishable side by side in a stacked band, so
 * Kimi's warmer orange is kept clear of Claude's.
 */
export const PROVIDER_PRESENTATION = {
  codex: {
    label: "Codex",
    color: "var(--foreground)",
    mark: OpenAI,
  },
  claude: {
    label: "Claude Code",
    color: "#d97757",
    mark: ClaudeAI,
  },
  grok: {
    label: "Grok",
    color: "#8b8b8b",
    mark: GrokIcon,
  },
  kimi: {
    label: "Kimi",
    color: "#ff6a3d",
    mark: KimiIcon,
  },
} satisfies Record<UsageProviderKind, UsageProviderPresentation>;

/** The chart layers every series from zero, so order only controls how it is read. */
export const PROVIDER_ORDER = Object.keys(PROVIDER_PRESENTATION) as UsageProviderKind[];
