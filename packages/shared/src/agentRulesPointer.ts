/**
 * Shared shape for agent policy file pointers.
 *
 * Discord and the T3 server both inject rules as a path the agent should open:
 *
 * ```
 * ## <header>
 * rules: /absolute/path/to/rules.md
 * ```
 *
 * Never paste the rules body into the prompt — keep a single source-of-truth file.
 */
export function formatAgentRulesPointer(rulesPath: string, header: string): string {
  return `${header}
rules: ${rulesPath}`;
}
