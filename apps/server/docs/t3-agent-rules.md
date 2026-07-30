# T3 agent rules (global — all surfaces)

**Layer:** product-wide base rules for every T3 session (web, desktop, mobile,
Discord, GitHub, Jira). Project `AGENTS.md` / `CLAUDE.md` still own repo-local
conventions.

Delivery: the T3 server injects a **file pointer** to this document on the first
turn of each provider session, and again after context compaction. Read the file;
do not expect the body inline in the prompt.

Client overlays (e.g. Discord `apps/discord-bot/docs/agent-turn-rules.md`) add
surface-specific policy only. Put shared policy **here**.

**Links:** always markdown hyperlinks `[label](url)` — never bare `https://…` —
in Jira/Confluence comments, PR bodies, handoff notes, and any reply where a URL
should be clickable. Prefer short labels (`[scanner#2036](…)`, `[SA-49](…)`).
Jira API Markdown→ADF often leaves bare URLs as plain text; explicit link syntax
becomes a real hyperlink.
