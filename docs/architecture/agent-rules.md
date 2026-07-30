# Global T3 agent rules

Product-wide behavioral rules for agents running **through T3 Code**, independent of project `AGENTS.md` and independent of entry surface.

## Why

Per-project docs only reach agents that happen to open that repo. Discord-only turn rules only reach Discord. Writing conventions such as “always use markdown hyperlinks in Jira” need one choke point so web, desktop, mobile, Discord, GitHub, and Jira turns all see them.

## Where

| Layer                    | Path                                                                                             | Scope                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| **Global product rules** | [`apps/server/src/agentRules/T3AgentRules.ts`](../../apps/server/src/agentRules/T3AgentRules.ts) | All providers, all surfaces                                          |
| **Injection**            | [`ProviderService.sendTurn`](../../apps/server/src/provider/Layers/ProviderService.ts)           | Every provider turn input (not the stored chat message)              |
| **Codex session**        | [`CodexDeveloperInstructions.ts`](../../apps/server/src/provider/CodexDeveloperInstructions.ts)  | Also embedded in Codex developer instructions for session durability |
| **Discord-only policy**  | [`apps/discord-bot/docs/agent-turn-rules.md`](../../apps/discord-bot/docs/agent-turn-rules.md)   | cab trailers, PR footer, Discord style — pointed at by the bot       |

Project `AGENTS.md` remains the source of **repo-local** conventions. Global rules deliberately stay short so every turn can carry them without bloating context.

## How injection works

1. Clients and bridges (web / desktop / mobile / Discord bot / GitHub PR bridge / Jira issue bridge) create a normal user message and start a turn.
2. Orchestration stores the **original** message text for the UI.
3. When the turn is sent to a provider harness, `ProviderService.sendTurn` prepends the global rules block (idempotent via an HTML comment marker).
4. Codex sessions additionally receive the same body inside developer instructions at session start / mode switches.

Surface-specific context (Discord meta, GitHub PR stack, Jira issue keys) continues to be composed by each bridge and remains separate from product rules.

## Adding a rule

1. Prefer **global** only when every surface and every project should obey it.
2. Edit `T3_AGENT_RULES_BODY` in `T3AgentRules.ts` (keep it compact).
3. Add/adjust a unit test in `T3AgentRules.test.ts` and, when relevant, Codex instruction tests.
4. Discord-only mechanics go in `agent-turn-rules.md`, not in the global body.
