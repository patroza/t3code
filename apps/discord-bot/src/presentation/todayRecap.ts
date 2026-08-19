/**
 * Manual daily recap: `/omegent today-recap` (alias `/agent today-recap`).
 * The Discord channel (topic `t3-<shortName>`) picks the repo. No schedule —
 * someone has to run the command.
 */

export const TODAY_RECAP_SUBCOMMAND = "today-recap" as const;

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
  return `**${input.displayName}** asked for today's recap of \`${input.shortName}\` (${input.date}).`;
}

export function formatTodayRecapThreadTitle(input: {
  readonly shortName: string;
  readonly date: string;
}): string {
  return `today recap ${input.shortName} ${input.date}`;
}

/**
 * Prompt the agent posts in the recap thread. Format is the one we iterated in
 * Discord: what/why from PR bodies, `PR #N` links, bare thread URLs, status
 * headings with color circles, type outline (fix/feat/…).
 */
export function buildTodayRecapPrompt(input: {
  readonly shortName: string;
  readonly date: string;
  readonly parentChannelId: string;
}): string {
  return [
    `Write a small daily recap of GitHub PR opens, merges, and closes on ${input.date} (UTC calendar day) for the \`${input.shortName}\` repo bound to this Discord channel (<#${input.parentChannelId}>).`,
    "Do not recap other repos or companies.",
    "",
    "Use PR descriptions for what happened and why — not the code. Discord thread links are in PR descriptions.",
    "",
    "Format strictly:",
    "- Link each PR as [PR #N](github-url). The visible text must be exactly `PR #` plus the number (e.g. PR #2236).",
    "- Paste each Discord thread URL as a bare URL on its own line. Discord will show the thread title. Do not wrap thread URLs in markdown.",
    "- Categorize each PR as feat / fix / docs / chore / test / refactor from the branch name or the squashed / first conventional commit (prefer the commit when it disagrees with the title).",
    "- Separate by status with these headings:",
    "## 🟢 MERGED",
    "## 🔴 CLOSED",
    "## 🟠 OPEN",
    "- Under each status, outline by type:",
    "### fix",
    "### feat",
    "### docs",
    "  (omit empty type headings and empty status sections)",
    "- Group related PRs. A few sentences of what/why each. Not verbose.",
    "",
    "No code dumps. No process status. If nothing moved that day, say so in one line.",
  ].join("\n");
}
