# T3 agent rules (global — all surfaces)

**Layer:** product-wide base rules for every T3 session (web, desktop, mobile,
Discord, GitHub, Jira). Project `AGENTS.md` / `CLAUDE.md` still own repo-local
conventions.

T3 installs this file into **harness-global** instruction homes so providers
load it as user-level instructions that **survive compaction**:

- Codex: `$CODEX_HOME/t3-agent-rules.md` (symlink) + managed section in
  `$CODEX_HOME/AGENTS.md`
- Claude: `$CLAUDE_CONFIG_DIR/t3-agent-rules.md` + managed section in
  `CLAUDE.md`

Put shared policy **here**, not in client overlays or project AGENTS.md.

Client overlays (e.g. Discord `apps/discord-bot/docs/agent-turn-rules.md`) add
surface-specific policy only.

**Links:** always markdown hyperlinks `[label](url)` — never bare `https://…` —
in Jira/Confluence comments, PR bodies, handoff notes, and any reply where a URL
should be clickable. Prefer short labels (`[scanner#2036](…)`, `[SA-49](…)`).
Jira API Markdown→ADF often leaves bare URLs as plain text; explicit link syntax
becomes a real hyperlink.
