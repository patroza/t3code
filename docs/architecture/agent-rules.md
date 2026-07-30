# Global T3 agent rules + client overlays

Product-wide behavioral rules for agents running **through T3 Code**, independent of project `AGENTS.md`.

## Layering

```text
## Agent rules
rules: /…/t3-agent-rules.md          ← global (always)
rules: /…/agent-turn-rules.md        ← client overlay (when applicable)
```

| Layer               | File                                                                                           | When               |
| ------------------- | ---------------------------------------------------------------------------------------------- | ------------------ |
| **Global**          | [`apps/server/docs/t3-agent-rules.md`](../../apps/server/docs/t3-agent-rules.md)               | Every surface      |
| **Discord overlay** | [`apps/discord-bot/docs/agent-turn-rules.md`](../../apps/discord-bot/docs/agent-turn-rules.md) | Discord turns only |

Shared policy goes in the **global** file once. Overlays hold only surface-specific
mechanics (Discord cab/PR footer, …). Never restate global rules in an overlay.

## Injection

| Who                                     | What                                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Discord bot**                         | Emits `## Agent rules` with global (if monorepo path exists) + Discord overlay; then `## Discord conversation context` with `req:` / jira / … |
| **Server** (`ProviderService.sendTurn`) | Ensures global path is present via merge + de-dupe (`ensureAgentRulesPaths`). Stored chat text is not rewritten.                              |

Helpers: [`packages/shared/src/agentRulesPointer.ts`](../../packages/shared/src/agentRulesPointer.ts).

Agents **open each path** and follow the documents. Do not paste rule bodies into prompts.

## Adding a rule

1. **Shared across surfaces** → edit `apps/server/docs/t3-agent-rules.md`.
2. **Discord-only** → edit `apps/discord-bot/docs/agent-turn-rules.md`.
3. Future clients (GitHub/Jira overlays) → new overlay file + extra `rules:` line; keep global clean.
