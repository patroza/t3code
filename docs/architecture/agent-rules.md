# Global T3 agent rules

Product-wide behavioral rules for agents running **through T3 Code**, independent of project `AGENTS.md` and independent of entry surface.

## Pattern (unified)

Every surface uses a **file pointer**, not embedded policy text:

```text
## <context header>
rules: /absolute/path/to/rules.md
```

Shared formatter: [`formatAgentRulesPointer`](../../packages/shared/src/agentRulesPointer.ts).

| Rules file                                                                                     | Injected by                               | Header                            |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------- | --------------------------------- |
| [`apps/server/docs/t3-agent-rules.md`](../../apps/server/docs/t3-agent-rules.md)               | `ProviderService.sendTurn` (all surfaces) | `## T3 agent context`             |
| [`apps/discord-bot/docs/agent-turn-rules.md`](../../apps/discord-bot/docs/agent-turn-rules.md) | Discord bot turn builder                  | `## Discord conversation context` |

Agents **open the path** and follow the document. Do not paste rule bodies into prompts.

## Where

| Layer                 | Path                                         | Role                                              |
| --------------------- | -------------------------------------------- | ------------------------------------------------- |
| **Global rules file** | `apps/server/docs/t3-agent-rules.md`         | Product policy source of truth                    |
| **Path + wrap**       | `apps/server/src/agentRules/T3AgentRules.ts` | Resolve path; prepend pointer                     |
| **Injection**         | `ProviderService.sendTurn`                   | Every provider turn input (stored chat unchanged) |
| **Discord-only file** | `apps/discord-bot/docs/agent-turn-rules.md`  | cab, PR footer, Discord style                     |

Project `AGENTS.md` remains **repo-local**. Keep product rules short so agents can load them quickly.

## How injection works

1. Clients and bridges create a normal user message and start a turn.
2. Orchestration stores the **original** message text for the UI.
3. `ProviderService.sendTurn` prepends `## T3 agent context` + `rules: <path>` (idempotent via the header).
4. Discord turns additionally include a pointer to Discord-only rules in the composed prompt (same `rules:` shape).

## Adding a rule

1. Prefer **global** only when every surface and every project should obey it.
2. Edit `apps/server/docs/t3-agent-rules.md` (not TypeScript strings).
3. Cover the pointer shape in `T3AgentRules.test.ts`.
4. Discord-only mechanics go in `agent-turn-rules.md`.
