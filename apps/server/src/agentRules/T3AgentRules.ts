// @effect-diagnostics nodeBuiltinImport:off
/**
 * Product-wide agent rules (source of truth + helpers).
 *
 * Single delivery mechanism (all harnesses, all surfaces):
 * - Inject `## Agent rules` **file pointers** on the first provider turn of a session
 * - Clear the inject flag on context compaction, re-inject on the next turn
 *
 * Not project AGENTS.md. Not harness-home mutation. Bodies are never embedded;
 * agents open the rules file path.
 *
 * Discord overlay is surface-only (`agent-turn-rules.md` via Discord turn context).
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import {
  AGENT_RULES_HEADER,
  ensureAgentRulesPaths,
  formatAgentRulesPointers,
} from "@t3tools/shared/agentRulesPointer";

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

/** runtimePayload key: rules pointer already sent for this provider session. */
export const T3_AGENT_RULES_INJECTED_KEY = "t3AgentRulesInjected";

export { AGENT_RULES_HEADER };

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
    if (NodeFS.existsSync(candidate)) {
      return candidate;
    }
  }

  const materializeDir = NodePath.join(NodeOS.tmpdir(), "t3-code");
  const materialized = NodePath.join(materializeDir, "t3-agent-rules.md");
  if (!NodeFS.existsSync(materialized)) {
    NodeFS.mkdirSync(materializeDir, { recursive: true });
    NodeFS.writeFileSync(materialized, T3_AGENT_RULES_FALLBACK_MARKDOWN, "utf8");
  }
  return materialized;
}

/** Discord client overlay when monorepo layout is present. */
export function resolveDiscordAgentRulesPath(): string | null {
  const candidate = NodePath.resolve(
    serverPackageRoot(),
    "../discord-bot/docs/agent-turn-rules.md",
  );
  return NodeFS.existsSync(candidate) ? candidate : null;
}

export function isDiscordOriginatedTurnText(text: string | undefined): boolean {
  if (text === undefined) return false;
  return text.includes("## Discord conversation context");
}

/** Paths for this turn: global always; Discord overlay when Discord-originated. */
export function resolveT3AgentRulesPathsForTurn(providerInput: string | undefined): string[] {
  const paths = [resolveT3AgentRulesPath()];
  if (isDiscordOriginatedTurnText(providerInput)) {
    const overlay = resolveDiscordAgentRulesPath();
    if (overlay !== null) paths.push(overlay);
  }
  return paths;
}

export function formatT3AgentRulesPointer(rulesPath: string = resolveT3AgentRulesPath()): string {
  return formatAgentRulesPointers([rulesPath]);
}

export function readT3AgentRulesInjected(runtimePayload: unknown): boolean {
  if (
    runtimePayload === null ||
    typeof runtimePayload !== "object" ||
    Array.isArray(runtimePayload)
  ) {
    return false;
  }
  return (runtimePayload as Record<string, unknown>)[T3_AGENT_RULES_INJECTED_KEY] === true;
}

export function withT3AgentRules(providerInput: string | undefined): string | undefined {
  if (providerInput === undefined) {
    return undefined;
  }
  return ensureAgentRulesPaths(providerInput, resolveT3AgentRulesPathsForTurn(providerInput));
}

/**
 * Ensure turn input includes rules pointers when this session still needs them.
 * When `alreadyInjectedThisSession` is true, leave text unchanged until compaction
 * clears the flag.
 */
export function ensureT3AgentRulesInput(
  providerInput: string | undefined,
  hasAttachments: boolean,
  alreadyInjectedThisSession = false,
): string | undefined {
  if (alreadyInjectedThisSession) {
    return providerInput ?? (hasAttachments ? "" : undefined);
  }
  const wrapped = withT3AgentRules(providerInput ?? (hasAttachments ? "" : undefined));
  if (wrapped !== undefined && wrapped.trim().length > 0) {
    return wrapped;
  }
  return providerInput;
}
