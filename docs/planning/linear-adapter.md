# Linear adapter

Notes for a Linear adapter following Jira (`ntbs-todos.md`). Facts checked September 2026.

## API surface

- One GraphQL endpoint: `https://api.linear.app/graphql`. No REST. `@linear/sdk` is optional; this adapter needs a handful of mutations/queries.
- App errors hide behind HTTP 200: check the `errors` array and `success: false` on mutation payloads; rate limits return 400 with `extensions.code: "RATELIMITED"`.
- Rate limits are leaky buckets: 2,500 req/h per user (API key), 5,000 (OAuth app), plus complexity caps (10,000 points per query). Read `X-RateLimit-*` headers.
- Relay-style cursor pagination, 50 records default.

## Auth

- Personal API key: simplest; actions are attributed to the user. Scopeable read/write/admin, optionally team-limited.
- OAuth2 with `actor=app` installs the app as a workspace actor with its own identity — required for Agent Sessions. Access tokens last ~24 h; refresh rotates with a 30-minute replay grace.
- OAuth apps can register their webhook automatically per installing organization, each with its own signing secret.

## Webhooks

- Verify `Linear-Signature`: hex HMAC-SHA256 of the raw body (never re-stringify). Also check `webhookTimestamp` is within ~60 s (replay guard).
- Respond 200 within 5 s, or Linear retries 3 times (1 m, 1 h, 6 h) and may disable the webhook.
- Headers: `Linear-Delivery` (UUID per delivery — the dedup key), `Linear-Event`, `Linear-Timestamp`. Body: `action` create/update/remove, `type` (Issue, Comment, …), `data`, `updatedFrom`, `actor`.
- Resource types include Issue, Comment, Comment reaction, Issue attachment, Project, Document, Cycle.

## Agent Sessions (Developer Preview)

Purpose-built for coding agents: delegating an issue to the app or mentioning it creates an `AgentSession` and pushes `AgentSessionEvent` webhooks (`created`, `prompted`).

- After `created`, emit an activity within 10 s or the session renders unresponsive. (Webhook itself must 2xx within 5 s.)
- Outbound: `agentActivityCreate` with `thought`, `action` (action/parameter/result), `elicitation`, `response`, or `error`. Markdown; `thought`/`action` may be ephemeral. A `response` also creates an issue comment.
- `agentSessionUpdate` sets the plan (`pending|inProgress|completed|canceled`, tech preview) and external URLs. Activities carry signals: `stop`, `auth`, `select` (elicitation options). A `prompted` payload carries the user's message and its signals.
- Sessions can exist without an issue (document/editor mentions) — handle or reject explicitly.
- Enabling the webhook category immediately exposes Agent Session UI to workspace users.

## Mapping onto NTBS

- The port (`apps/server/src/ntbs/adapter.ts:31-56`) is outbound-only; inbound parsing and the webhook route live outside it.
  - `acknowledge` → `thought`; `postReply` → `response` (answer) or `error` (failure); `findPostedReply` → query `agentSession.activities` and match the exact stored body (frozen, queryable — a clean recovery story).
- `sourceUri`: `linear://<workspace>/agent-session/<sessionId>` meets both contracts (stable identity, cold-start addressability).
- Inbound route mirrors `apps/server/src/jira/http.ts`: verify signature, dedup on `Linear-Delivery` (persist like `JiraDeliveryStore.ts`), respond 200/202 immediately, fork processing.
- Config mirrors `jira/JiraAppConfig.ts` (`T3CODE_LINEAR_*`: token/secret, mention, allowed teams, project map, base branch).

## Risks / open decisions

1. **Ack deadline vs provisioning.** NTBS acknowledges only after thread provisioning (`processor.ts:346-347`), which includes worktree creation and setup scripts and can exceed 10 s. Either the webhook handler emits the initial `thought` before handing off, or the ack moves earlier.
2. **Preview API and the alternative.** Agent Sessions are a Developer Preview and validate activity shapes server-side. The comment-mention bridge is the GA, Jira-shaped fallback: no session UI, plan, or elicitation, and no 10 s deadline.
3. **Follow-ups.** NTBS models one exchange per thread, and `T3Target` only mints new threads. Decide how a `prompted` message continues an existing session, and where a `stop` signal lands (the adapter cannot reach the processor mid-exchange).
4. **Prerequisites.** `makeNTBSProcessor` is not wired into the server, the repository is in-memory, and `findNonTerminalExchanges` lacks a platform filter (`processor.ts:178-186`), so two processors would re-drive each other's exchanges. `SourceChannel` has no `"linear"` (`packages/contracts/src/identity.ts:60-73`) and NTBS turns do not stamp `source`; decide attribution when wiring.

Sources: [GraphQL](https://linear.app/developers/graphql), [webhooks](https://linear.app/developers/webhooks), [agent interaction](https://linear.app/developers/agent-interaction), [agent best practices](https://linear.app/developers/agent-best-practices), [rate limiting](https://linear.app/developers/rate-limiting), [actor authorization](https://linear.app/developers/oauth-actor-authorization).
