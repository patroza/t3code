/**
 * Shared shape for agent policy file pointers.
 *
 * Product policy is layered:
 * 1. Global rules file (all surfaces) — always first
 * 2. Optional client overlay (Discord, …) — additional `rules:` lines
 *
 * Injection shape (never paste rule bodies into the prompt):
 *
 * ```
 * ## Agent rules
 * rules: /absolute/path/to/t3-agent-rules.md
 * rules: /absolute/path/to/agent-turn-rules.md
 * ```
 */

/** Canonical header for the unified rules block (global + overlays). */
export const AGENT_RULES_HEADER = "## Agent rules";

const RULES_LINE = /^rules:\s+(\S+)\s*$/u;

function normalizePath(path: string): string {
  return path.trim();
}

/** Stable de-dupe preserving first-seen order. */
export function dedupeAgentRulesPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const path = normalizePath(raw);
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    out.push(path);
  }
  return out;
}

/**
 * Format one or more rules-file pointers under a single header.
 * Empty input → empty string.
 */
export function formatAgentRulesPointers(
  rulesPaths: readonly string[],
  header: string = AGENT_RULES_HEADER,
): string {
  const unique = dedupeAgentRulesPaths(rulesPaths);
  if (unique.length === 0) return "";
  return `${header}\n${unique.map((path) => `rules: ${path}`).join("\n")}`;
}

/** @deprecated Prefer formatAgentRulesPointers — kept for single-path call sites. */
export function formatAgentRulesPointer(rulesPath: string, header: string): string {
  return formatAgentRulesPointers([rulesPath], header);
}

/**
 * Collect `rules: <path>` lines from a `## Agent rules` (or custom header) block.
 * Stops at the next markdown H2.
 */
export function extractAgentRulesPaths(
  text: string,
  header: string = AGENT_RULES_HEADER,
): string[] {
  const lines = text.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex < 0) return [];

  const paths: string[] = [];
  for (let i = headerIndex + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s+/u.test(line)) break;
    const match = RULES_LINE.exec(line);
    if (match?.[1]) paths.push(match[1]);
  }
  return dedupeAgentRulesPaths(paths);
}

/**
 * Strip an existing agent-rules block (header + following `rules:` lines / blanks
 * until the next H2 or non-rules content that is not blank).
 */
export function stripAgentRulesBlock(text: string, header: string = AGENT_RULES_HEADER): string {
  const lines = text.split("\n");
  const headerIndex = lines.findIndex((line) => line.trim() === header);
  if (headerIndex < 0) return text;

  let end = headerIndex + 1;
  while (end < lines.length) {
    const line = lines[end] ?? "";
    if (/^##\s+/u.test(line)) break;
    if (line.trim() === "" || RULES_LINE.test(line)) {
      end += 1;
      continue;
    }
    break;
  }

  const next = [...lines.slice(0, headerIndex), ...lines.slice(end)].join("\n");
  return next.replace(/^\n+/u, "").replace(/\n{3,}/gu, "\n\n");
}

/**
 * Ensure `requiredPaths` appear in the unified agent-rules block (global first).
 * Replaces any existing block with a merged, de-duplicated list.
 */
export function ensureAgentRulesPaths(
  text: string,
  requiredPaths: readonly string[],
  header: string = AGENT_RULES_HEADER,
): string {
  const existing = extractAgentRulesPaths(text, header);
  const merged = dedupeAgentRulesPaths([...requiredPaths, ...existing]);
  const without = stripAgentRulesBlock(text, header).trimEnd();
  const block = formatAgentRulesPointers(merged, header);
  if (block.length === 0) return without;
  if (without.length === 0) return block;
  return `${block}\n\n${without}`;
}
