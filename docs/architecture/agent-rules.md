# Global T3 agent rules

Product-wide behavioral rules for agents running **through T3 Code**, independent of project `AGENTS.md`.

## Single mechanism

**Session inject + re-inject after compaction** — one path for every harness (Codex, Claude, Grok, OpenCode, Kimi, Cursor, …) and every surface (web, desktop, mobile, Discord, GitHub, Jira).

```
First turn of a provider session
  → prepend ## Agent rules / rules: <path> to the provider input
  → mark t3AgentRulesInjected on the session runtime payload

Later turns
  → skip (flag set)

thread.state.changed / compacted
  → clear t3AgentRulesInjected

Next turn after compaction
  → inject again
```

- Source of truth: [`apps/server/docs/t3-agent-rules.md`](../../apps/server/docs/t3-agent-rules.md)
- Helpers: [`T3AgentRules.ts`](../../apps/server/src/agentRules/T3AgentRules.ts)
- Wiring: [`ProviderService.sendTurn`](../../apps/server/src/provider/Layers/ProviderService.ts) + compaction handling in `persistRuntimeEventState`
- Bodies are **not** embedded; agents open the file path
- Stored chat messages are not rewritten; only the provider payload is wrapped

## Why this shape

- Works the same for every harness (no special-casing home dirs)
- Compaction drops transcript history → re-inject is how rules re-enter context
- Avoids mutating harness-global or project `AGENTS.md` / `CLAUDE.md`

## Discord overlay

| Layer            | File                                        | When                          |
| ---------------- | ------------------------------------------- | ----------------------------- |
| **Global**       | `apps/server/docs/t3-agent-rules.md`        | Session inject (all surfaces) |
| **Discord-only** | `apps/discord-bot/docs/agent-turn-rules.md` | Discord turn `rules:` line    |

Dynamic Discord fields (`req`, `jira`, `cab`, `pr`, `t3`) still appear each turn.

## Adding a rule

1. Shared → edit `apps/server/docs/t3-agent-rules.md`
2. Discord-only → edit `apps/discord-bot/docs/agent-turn-rules.md`
