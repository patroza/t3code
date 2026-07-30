# Global T3 agent rules + client overlays

Product-wide behavioral rules for agents running **through T3 Code**, independent of **project** `AGENTS.md`.

## Goal

1. Apply on **every surface** (web, desktop, mobile, Discord, GitHub, Jira)
2. Work on **every harness** (Codex, Claude, Grok, OpenCode, Kimi, Cursor, …)
3. **Survive context compaction**
4. Stay out of **project** instruction files

## Dual delivery

### A. Harness-global install (preferred durable path)

Installed when each provider driver starts:

| Harness  | Home                                | File                                      |
| -------- | ----------------------------------- | ----------------------------------------- |
| Codex    | `$CODEX_HOME`                       | `AGENTS.md` + `t3-agent-rules.md` symlink |
| Claude   | `$CLAUDE_CONFIG_DIR` / `~/.claude`  | `CLAUDE.md` + symlink                     |
| Grok     | `~/.grok` / `$GROK_HOME`            | `AGENTS.md` + symlink                     |
| Kimi     | `$KIMI_CODE_HOME` / `~/.kimi`       | `AGENTS.md` + symlink                     |
| OpenCode | `~/.config/opencode`, `~/.opencode` | `AGENTS.md` + symlink                     |
| Cursor   | `~/.cursor` / `$CURSOR_HOME`        | `AGENTS.md` + symlink                     |

Managed marker section preserves the user’s other global prefs. Source of truth:
[`apps/server/docs/t3-agent-rules.md`](../../apps/server/docs/t3-agent-rules.md).

### B. Session inject + re-inject after compaction (universal backup)

`ProviderService.sendTurn`:

1. On first turn of a provider session → prepend `## Agent rules` file pointers
2. Mark `t3AgentRulesInjected` on the session runtime payload
3. On `thread.state.changed` with `compacted` → clear the flag
4. Next turn re-injects so rules re-enter context after compaction

This path covers harnesses that ignore global AGENTS.md, or when install fails.

Codex also keeps a one-line path in `developer_instructions`.

## Discord

- Global rules: harness + session inject (above)
- Overlay: `apps/discord-bot/docs/agent-turn-rules.md` via turn `rules:` line
- Dynamic fields (`req`, `cab`, `pr`, …) still every Discord turn

## Adding a rule

1. Shared → `apps/server/docs/t3-agent-rules.md`
2. Discord-only → `apps/discord-bot/docs/agent-turn-rules.md`
