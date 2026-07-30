/**
 * Product-wide agent rules (source of truth + helpers).
 *
 * Delivery model (survives compaction):
 * - Install into **harness-global** instruction files via
 *   `HarnessGlobalAgentRules` (`$CODEX_HOME/AGENTS.md`, Claude user `CLAUDE.md`)
 *   so providers load them as system/user instructions — not chat history.
 * - Codex also gets a path pointer in developer_instructions.
 * - Do **not** mutate project AGENTS.md / CLAUDE.md.
 * - Do **not** re-paste rules into every user turn.
 *
 * Discord client overlay remains a separate surface file; dynamic Discord
 * fields (req/jira/cab/pr) still go on each Discord turn.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { formatAgentRulesPointers } from "@t3tools/shared/agentRulesPointer";

/** Fallback body when the package docs file is missing (bundled `dist/` binary). */
const T3_AGENT_RULES_FALLBACK_MARKDOWN = `# T3 agent rules (all surfaces)

Product rules for every T3 turn (web, desktop, mobile, Discord, GitHub, Jira).
Project \`AGENTS.md\` still owns repo-local conventions.

**Links:** always markdown hyperlinks \`[label](url)\` — never bare \`https://…\` —
in Jira/Confluence comments, PR bodies, handoff notes, and any reply where a URL
should be clickable. Prefer short labels (\`[scanner#2036](…)\`, \`[SA-49](…)\`).
Jira API Markdown→ADF often leaves bare URLs as plain text; explicit link syntax
becomes a real hyperlink.
`;

export { AGENT_RULES_HEADER } from "@t3tools/shared/agentRulesPointer";

function serverPackageRoot(): string {
  return NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
}

/**
 * Absolute path to the product-wide rules markdown file.
 * Prefer the packaged/source docs path; materialize a temp copy if missing.
 */
export function resolveT3AgentRulesPath(): string {
  const root = serverPackageRoot();
  const candidates = [
    NodePath.resolve(root, "docs/t3-agent-rules.md"),
    NodePath.resolve(root, "src/docs/t3-agent-rules.md"),
    NodePath.resolve(root, "t3-agent-rules.md"),
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

/** Discord client overlay when monorepo layout is present. */
export function resolveDiscordAgentRulesPath(): string | null {
  const candidate = NodePath.resolve(
    serverPackageRoot(),
    "../discord-bot/docs/agent-turn-rules.md",
  );
  return existsSync(candidate) ? candidate : null;
}

/** Compact pointer block (tests / rare call sites). Prefer harness install. */
export function formatT3AgentRulesPointer(rulesPath: string = resolveT3AgentRulesPath()): string {
  return formatAgentRulesPointers([rulesPath]);
}

/**
 * One-line session instruction for Codex developer_instructions.
 * Points at the product file — does not embed the body.
 */
export function formatT3AgentRulesSessionPointer(
  rulesPath: string = resolveT3AgentRulesPath(),
): string {
  return `T3 product rules (all surfaces): read and follow ${rulesPath}`;
}
