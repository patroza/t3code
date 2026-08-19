/** Channel topic `t3-<shortName>` picks the repo. No schedule. */

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
  return `**${input.displayName}** asked for today's recap of \`${input.shortName}\` (${input.date} UTC).`;
}

export function formatTodayRecapThreadTitle(input: {
  readonly shortName: string;
  readonly date: string;
}): string {
  return `today recap ${input.shortName} ${input.date}`;
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
    "No code dumps. No process status. If nothing merged, closed, or opened that day, reply with exactly: no change",
  ].join("\n");
}
