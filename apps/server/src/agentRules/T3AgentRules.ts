/**
 * Product-wide agent rules — file pointer injection (same pattern as Discord).
 *
 * Surfaces (web, desktop, mobile, Discord bot, GitHub PR bridge, Jira issue
 * bridge) all reach the agent through `ProviderService.sendTurn`. On every turn
 * we prepend a compact pointer:
 *
 * ```
 * ## T3 agent context
 * rules: /absolute/path/to/t3-agent-rules.md
 * ```
 *
 * The agent reads the markdown file. We do **not** embed the rules body in the
 * prompt (matches Discord's `agent-turn-rules.md` pointer).
 *
 * Discord-only policy stays in `apps/discord-bot/docs/agent-turn-rules.md`.
 * Stored chat messages are not rewritten — only the provider payload is wrapped.
 */

import { formatAgentRulesPointer } from "@t3tools/shared/agentRulesPointer";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

/** Fallback body when the package docs file is missing (bundled `dist/` binary). */
const T3_AGENT_RULES_FALLBACK_MARKDOWN = `# T3 agent rules (all surfaces)

Product rules for every T3 turn (web, desktop, mobile, Discord, GitHub, Jira).
Project \`AGENTS.md\` still owns repo-local conventions.

The T3 server injects an absolute path to this file on every provider turn
(\`rules: /…/t3-agent-rules.md\`). Read the file; do not expect the body inline.

**Links:** always markdown hyperlinks \`[label](url)\` — never bare \`https://…\` —
in Jira/Confluence comments, PR bodies, handoff notes, and any reply where a URL
should be clickable. Prefer short labels (\`[scanner#2036](…)\`, \`[SA-49](…)\`).
Jira API Markdown→ADF often leaves bare URLs as plain text; explicit link syntax
becomes a real hyperlink.
`;

/** Header used for idempotent re-injection detection. */
export const T3_AGENT_RULES_HEADER = "## T3 agent context";

export { formatAgentRulesPointer };

/**
 * Absolute path to the product-wide rules markdown file.
 * Prefer the packaged/source docs path; materialize a temp copy if missing.
 */
export function resolveT3AgentRulesPath(): string {
  const moduleDir = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
  // src/agentRules → apps/server/docs/t3-agent-rules.md (source / monorepo deploy)
  // dist chunk → may not exist; fall through to materialize
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

/** Compact pointer block prepended to provider turn input. */
export function formatT3AgentRulesPointer(rulesPath: string = resolveT3AgentRulesPath()): string {
  return formatAgentRulesPointer(rulesPath, T3_AGENT_RULES_HEADER);
}

/**
 * Prepend a rules **file path** pointer (not the rules body).
 * Idempotent when the header is already present.
 */
export function withT3AgentRules(providerInput: string | undefined): string | undefined {
  if (providerInput === undefined) {
    return undefined;
  }
  if (providerInput.includes(T3_AGENT_RULES_HEADER)) {
    return providerInput;
  }
  const pointer = formatT3AgentRulesPointer();
  const body = providerInput.trimEnd();
  if (body.length === 0) {
    return pointer;
  }
  return `${pointer}

${body}`;
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
