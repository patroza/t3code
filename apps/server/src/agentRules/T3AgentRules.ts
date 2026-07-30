/**
 * Product-wide agent rules injected on every provider turn.
 *
 * Surfaces (web, desktop, mobile, Discord bot, GitHub PR bridge, Jira issue
 * bridge) all reach the agent through `ProviderService.sendTurn`. Rules here
 * apply regardless of entry point and regardless of the project's AGENTS.md.
 *
 * Discord-only policy (cab trailers, PR footer snowflakes, etc.) stays in
 * `apps/discord-bot/docs/agent-turn-rules.md` and is pointed at by the bot.
 *
 * Stored chat messages are not rewritten — only the payload sent to the
 * provider harness is wrapped, so the UI stays clean.
 */

/** Marker so re-injection (steers, retries, nested wrappers) stays idempotent. */
export const T3_AGENT_RULES_MARKER = "<!-- t3-agent-rules -->";

/**
 * Compact global policy. Keep this short: it is prepended on every turn to
 * survive context compaction and mid-session resumes.
 */
export const T3_AGENT_RULES_BODY = `## T3 agent rules (all surfaces)

Product rules for every T3 turn (web, desktop, mobile, Discord, GitHub, Jira). Project \`AGENTS.md\` still owns repo-local conventions.

**Links:** always markdown hyperlinks \`[label](url)\` — never bare \`https://…\` — in Jira/Confluence comments, PR bodies, handoff notes, and any reply where a URL should be clickable. Prefer short labels (\`[scanner#2036](…)\`, \`[SA-49](…)\`). Jira API Markdown→ADF often leaves bare URLs as plain text; explicit link syntax becomes a real hyperlink.`;

export const T3_AGENT_RULES_BLOCK = `${T3_AGENT_RULES_MARKER}
${T3_AGENT_RULES_BODY}`;

/**
 * Prepend global T3 agent rules to provider turn input.
 * Idempotent when the marker is already present.
 */
export function withT3AgentRules(providerInput: string | undefined): string | undefined {
  if (providerInput === undefined) {
    return undefined;
  }
  if (providerInput.includes(T3_AGENT_RULES_MARKER)) {
    return providerInput;
  }
  const body = providerInput.trimEnd();
  if (body.length === 0) {
    return T3_AGENT_RULES_BLOCK;
  }
  return `${T3_AGENT_RULES_BLOCK}

${body}`;
}

/**
 * Ensure turn input includes global rules even for attachment-only turns
 * (where text may be empty/undefined).
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
