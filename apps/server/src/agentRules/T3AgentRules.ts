/**
 * Product-wide agent rules — file pointer injection (unified with Discord).
 *
 * Layering:
 * 1. Global file: `apps/server/docs/t3-agent-rules.md` (all surfaces)
 * 2. Optional client overlays (e.g. Discord `agent-turn-rules.md`) — extra
 *    `rules:` lines under the same `## Agent rules` block
 *
 * `ProviderService.sendTurn` ensures the global path is present (merged +
 * de-duplicated). Surfaces never embed rule bodies in the prompt.
 */

import {
  AGENT_RULES_HEADER,
  ensureAgentRulesPaths,
  formatAgentRulesPointers,
} from "@t3tools/shared/agentRulesPointer";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** Fallback body when the package docs file is missing (bundled `dist/` binary). */
const T3_AGENT_RULES_FALLBACK_MARKDOWN = `# T3 agent rules (all surfaces)

Product rules for every T3 turn (web, desktop, mobile, Discord, GitHub, Jira).
Project \`AGENTS.md\` still owns repo-local conventions.

Read this file when a turn lists it under \`## Agent rules\` as \`rules: …\`.
Do not expect the body inline in the prompt.

**Links:** always markdown hyperlinks \`[label](url)\` — never bare \`https://…\` —
in Jira/Confluence comments, PR bodies, handoff notes, and any reply where a URL
should be clickable. Prefer short labels (\`[scanner#2036](…)\`, \`[SA-49](…)\`).
Jira API Markdown→ADF often leaves bare URLs as plain text; explicit link syntax
becomes a real hyperlink.
`;

export { AGENT_RULES_HEADER };

/**
 * Absolute path to the product-wide rules markdown file.
 * Prefer the packaged/source docs path; materialize a temp copy if missing.
 */
export function resolveT3AgentRulesPath(): string {
  const moduleDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  // src/agentRules → apps/server/docs/t3-agent-rules.md (source / monorepo deploy)
  const candidates = [
    NodePath.resolve(moduleDir, "../../docs/t3-agent-rules.md"),
    NodePath.resolve(moduleDir, "../docs/t3-agent-rules.md"),
    NodePath.resolve(moduleDir, "t3-agent-rules.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  const materializeDir = NodePath.join(tmpdir(), "t3-code");
  const materialized = NodePath.join(materializeDir, "t3-agent-rules.md");
  if (!existsSync(materialized)) {
    mkdirSync(materializeDir, { recursive: true });
    writeFileSync(materialized, T3_AGENT_RULES_FALLBACK_MARKDOWN, "utf8");
  }
  return materialized;
}

/** Compact pointer block for the global rules file alone. */
export function formatT3AgentRulesPointer(rulesPath: string = resolveT3AgentRulesPath()): string {
  return formatAgentRulesPointers([rulesPath]);
}

/**
 * Ensure the global rules **file path** is listed under `## Agent rules`.
 * Merges with any existing paths (client overlays) and de-duplicates.
 */
export function withT3AgentRules(providerInput: string | undefined): string | undefined {
  if (providerInput === undefined) {
    return undefined;
  }
  return ensureAgentRulesPaths(providerInput, [resolveT3AgentRulesPath()]);
}

/**
 * Ensure turn input includes the global rules pointer even for attachment-only
 * turns (where text may be empty/undefined).
 */
export function ensureT3AgentRulesInput(
  providerInput: string | undefined,
  hasAttachments: boolean,
): string | undefined {
  const wrapped = withT3AgentRules(providerInput ?? (hasAttachments ? "" : undefined));
  if (wrapped !== undefined && wrapped.trim().length > 0) {
    return wrapped;
  }
  return providerInput;
}
