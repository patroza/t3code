# Global T3 agent rules + client overlays

Product-wide behavioral rules for agents running **through T3 Code**, independent of **project** `AGENTS.md`.

## Goal

Rules must:

1. Apply on **every surface** (web, desktop, mobile, Discord, GitHub, Jira)
2. **Survive context compaction** (not only early chat turns)
3. Stay out of **project** `AGENTS.md` / `CLAUDE.md` (those remain repo-local)

## Delivery: harness-global instruction files

T3 installs product rules into each **provider harness home** — the same place Codex/Claude already load **user-global** instructions (not project files):

| Harness | Home                                | Instruction file | Link                               |
| ------- | ----------------------------------- | ---------------- | ---------------------------------- |
| Codex   | `$CODEX_HOME`                       | `AGENTS.md`      | `t3-agent-rules.md` → product file |
| Claude  | `$CLAUDE_CONFIG_DIR` or `~/.claude` | `CLAUDE.md`      | same                               |

Mechanism: [`HarnessGlobalAgentRules.ts`](../../apps/server/src/agentRules/HarnessGlobalAgentRules.ts)

1. Symlink `<home>/t3-agent-rules.md` → [`apps/server/docs/t3-agent-rules.md`](../../apps/server/docs/t3-agent-rules.md)
2. Upsert a **managed marker section** in the harness instruction file (preserves the user’s other global prefs)

Codex also gets a one-line path pointer in `developer_instructions` (session-level backup).

**Not** a symlink of project `AGENTS.md`. Project files stay the project’s.

## Why this survives compaction

Conversation compaction drops or summarizes old **chat turns**. Harness-global
`AGENTS.md` / `CLAUDE.md` are loaded as **user/system instruction sources** by
the provider, outside the compactable transcript — same class of durability as
other harness-global agent prefs.

Per-turn paste of policy (or long pointer blocks) does **not** meet this bar.

## Client overlays (Discord)

| Layer               | File                                        | When                          |
| ------------------- | ------------------------------------------- | ----------------------------- |
| **Global**          | `apps/server/docs/t3-agent-rules.md`        | All surfaces via harness home |
| **Discord overlay** | `apps/discord-bot/docs/agent-turn-rules.md` | Discord turns (`rules:` path) |

Dynamic Discord fields (`req`, `jira`, `cab`, `pr`, `t3`) **must** still appear
each turn — they are not static rules.

## Adding a rule

1. **Shared across surfaces** → edit `apps/server/docs/t3-agent-rules.md`.
2. **Discord-only** → edit `apps/discord-bot/docs/agent-turn-rules.md`.
3. Do not put product policy in project AGENTS.md templates.
