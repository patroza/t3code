# T3 agent rules (global — all surfaces)

**Layer:** product-wide base rules for every T3 turn (web, desktop, mobile,
Discord, GitHub, Jira). Project `AGENTS.md` still owns repo-local conventions.

Client overlays (e.g. Discord `apps/discord-bot/docs/agent-turn-rules.md`) add
surface-specific policy as extra `rules:` paths under the same `## Agent rules`
block. Put shared policy **here**, not in overlays.

Turns list this file as a path pointer (`rules: /…/t3-agent-rules.md`). Read the
file; do not expect the body inline in the prompt.

**Links:** always markdown hyperlinks `[label](url)` — never bare `https://…` —
in Jira/Confluence comments, PR bodies, handoff notes, and any reply where a URL
should be clickable. Prefer short labels (`[scanner#2036](…)`, `[SA-49](…)`).
Jira API Markdown→ADF often leaves bare URLs as plain text; explicit link syntax
becomes a real hyperlink.
