# T3 agent rules (all surfaces)

Product rules for every T3 turn (web, desktop, mobile, Discord, GitHub, Jira).
Project `AGENTS.md` still owns repo-local conventions.

The T3 server injects an absolute path to this file on every provider turn
(`rules: /…/t3-agent-rules.md`). Read the file; do not expect the body inline.

**Links:** always markdown hyperlinks `[label](url)` — never bare `https://…` —
in Jira/Confluence comments, PR bodies, handoff notes, and any reply where a URL
should be clickable. Prefer short labels (`[scanner#2036](…)`, `[SA-49](…)`).
Jira API Markdown→ADF often leaves bare URLs as plain text; explicit link syntax
becomes a real hyperlink.
