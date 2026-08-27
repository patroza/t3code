/** Channel topic `t3-<shortName>` picks the repo. No schedule. */

export const TODAY_RECAP_SUBCOMMAND = "today-recap" as const;

/** Interaction tokens last 15 minutes; leave headroom after GitHub lookups. */
export const TODAY_RECAP_TURN_TIMEOUT_MS = 10 * 60 * 1000;
export const TODAY_RECAP_TURN_POLL_MS = 1500;

export function extractLatestAssistantText(
  messages: ReadonlyArray<{ readonly role: string; readonly text?: string | null }>,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    const text = message.text?.trim() ?? "";
    if (text.length > 0) return text;
  }
  return null;
}

/** YYYY-MM-DD from an ISO timestamp (`DateTime.formatIso`). */
export function utcDateStamp(isoNow: string): string {
  const stamp = isoNow.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(stamp) ? stamp : isoNow;
}

/** Replaces Discord's deferred "thinking" spinner so the slash does not look stuck. */
export function formatTodayRecapWorking(input: {
  readonly shortName: string;
  readonly date: string;
}): string {
  return `Writing today's recap of \`${input.shortName}\` (${input.date} UTC)…`;
}

export function formatTodayRecapThreadTitle(input: {
  readonly shortName: string;
  readonly date: string;
}): string {
  return `today recap ${input.shortName} ${input.date}`;
}

const DISCORD_RECAP_CHUNK_LIMIT = 2000;

/** Split a recap on blank lines so a Discord follow-up never cuts a PR block in half. */
export function chunkTodayRecapContent(
  content: string,
  limit = DISCORD_RECAP_CHUNK_LIMIT,
): string[] {
  const trimmed = content.trimEnd();
  if (trimmed.length === 0) return [""];
  if (trimmed.length <= limit) return [trimmed];

  const blocks = trimmed.split(/\n{2,}(?=\[PR #\d|## )/);
  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.length === 0) return;
    chunks.push(current);
    current = "";
  };
  for (const block of blocks) {
    if (block.length > limit) {
      flush();
      let remaining = block;
      while (remaining.length > limit) {
        let splitAt = remaining.lastIndexOf("\n", limit);
        if (splitAt < Math.floor(limit * 0.5)) {
          splitAt = remaining.lastIndexOf(" ", limit);
        }
        if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
        chunks.push(remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).trimStart();
      }
      if (remaining.length > 0) current = remaining;
      continue;
    }
    const next = current.length === 0 ? block : `${current}\n\n${block}`;
    if (next.length > limit) {
      flush();
      current = block;
    } else {
      current = next;
    }
  }
  flush();
  return chunks;
}

export function buildTodayRecapPrompt(input: {
  readonly shortName: string;
  readonly date: string;
  readonly parentChannelId: string;
}): string {
  return [
    `Write a small daily recap of GitHub PRs for the \`${input.shortName}\` repo bound to this Discord channel (<#${input.parentChannelId}>).`,
    `Use GitHub's UTC calendar day ${input.date}. Query this workspace's GitHub origin — not other repos.`,
    "List PRs with `gh pr list --state merged|closed|open` and filter that UTC day locally. Do not use `gh search` or `--search closed:DATE` — those miss unmerged closes.",
    "",
    "Read-only: do not edit files, do not checkout/commit/push, do not open a PR. The recap is the Discord message.",
    "",
    "Include only PRs that moved on that UTC day:",
    "- MERGED: merged that day",
    "- CLOSED: closed without merge that day",
    "- OPEN: opened that day and still open — not the rest of the open backlog",
    "",
    "Use PR descriptions for what happened and why — not the code. Discord thread links are in PR descriptions.",
    "",
    "Format strictly:",
    "- Status headings (omit empty sections):",
    "## 🟢 MERGED",
    "## 🔴 CLOSED",
    "## 🟠 OPEN",
    '- Related PRs (same change, follow-up, or a first try closed because a later PR handled it) are ONE block headed by the latest PR: OPEN if any is still open, else MERGED, else CLOSED. Weave earlier related PRs into that heading PR\'s description as [PR #N](url) (feat) plus a short what/why. Do not give them their own blocks. Do not write "landed today".',
    "- Unrelated PRs: one block each. A closed PR with no connection to another PR that moved today goes only under CLOSED.",
    "- Heading line: [PR #N](github-url) (fix). Visible text is exactly `PR #` plus the number. Types: (fix) (feat) (docs) (chore) (test) (refactor) from the branch or the squashed / first conventional commit (prefer the commit).",
    "- Bare Discord thread URL on its own line. Do not wrap thread URLs in markdown. Do not use ### type headings.",
    "- Plain language: what the user sees now and why. Spell out shop-floor terms on first use (Kein Versand = the app will not ship this order; Packmittel = packing materials; Lieferschein = delivery note). No jargon-only lines.",
    "- A few sentences. Not verbose. Blank line between blocks.",
    "",
    "No code dumps. No process status. If nothing merged, closed, or opened that day, reply with exactly: no change",
  ].join("\n");
}
