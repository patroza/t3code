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

export function formatTodayRecapAck(input: {
  readonly displayName: string;
  readonly shortName: string;
  readonly date: string;
}): string {
  return `**${input.displayName}** asked for today's recap of \`${input.shortName}\` (${input.date} UTC).`;
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

/**
 * Split a recap on blank lines so a Discord 2000-char follow-up never cuts a PR
 * block in half (the live recap split PR #1880 mid-sentence).
 */
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
    "- Related PRs (same change, follow-up, or a first try that was closed because a later PR handled it) are ONE block. Tell that history once. Do not list those related PRs again in MERGED, CLOSED, or OPEN.",
    "- Head the block with the latest PR in the chain. If any of them is still open, put the block under OPEN. Else if any merged, under MERGED. Else CLOSED.",
    '- Mention earlier related PRs inline as [PR #N](github-url) (fix) plus that PR\'s Discord thread URL on its own line. Put 🟢 / 🔴 / 🟠 immediately next to the status words so a scan catches them: `🟢 landed today`, `🔴 closed`, `🟠 still open`. Example: [PR #111](url) (fix) then its Discord URL, then "First try was [PR #222](url) (feat) 🔴 closed because [PR #333](url) (feat) 🟢 landed today and handled it better" — then #222 and #333 get no blocks of their own.',
    "- Unrelated PRs stay one block each. A closed PR with no connection to another PR that moved today goes only under CLOSED.",
    "- Link the heading PR as [PR #N](github-url) (fix) — type in parentheses on the same line as the link. Visible link text is exactly `PR #` plus the number (e.g. PR #2236). Types: (fix) (feat) (docs) (chore) (test) (refactor) from the branch name or the squashed / first conventional commit (prefer the commit when it disagrees with the title).",
    "- Do not use ### type headings.",
    "- Paste each Discord thread URL as a bare URL on its own line. Discord will show the thread title. Do not wrap thread URLs in markdown.",
    "- Separate by status with these headings (omit empty status sections):",
    "## 🟢 MERGED",
    "## 🔴 CLOSED",
    "## 🟠 OPEN",
    '- Write so someone who does not know the ticket can understand it: what the user sees now, and why it changed. Spell out shop-floor terms on first use (Kein Versand = the app will not ship this order; Packmittel = packing materials; Lieferschein = delivery note). No jargon-only lines like "tighten packing presentation" or "realigns the marker".',
    "- A few sentences of what/why. Not verbose. Blank line between blocks so Discord splits never cut a story in half.",
    "",
    "No code dumps. No process status. If nothing merged, closed, or opened that day, reply with exactly: no change",
  ].join("\n");
}
