# NTBS skeleton adversarial review

**Status:** review of the declaration-phase skeleton in `apps/server/src/ntbs`

**Scope:** `schemas.ts`, `processor.ts`, `platform-handler.ts`, `adapter.ts`, reviewed against [ntbs.md](./ntbs.md), [ntbs-architecture.md](./ntbs-architecture.md), [ntbs-event-processing.md](./ntbs-event-processing.md), [ntbs-plan.md](./ntbs-plan.md), and the existing implementation (`apps/server/src/jira`, `apps/server/src/github`, `apps/server/src/ws.ts`, `apps/server/src/orchestration`, `packages/contracts`).

## Verdict

The core seam is right — a shared lifecycle processor with per-platform adapters is exactly what `JiraIssueBridge` and `GitHubPrBridge` already share informally (they import each other's outcome-resolution helpers), and thread-per-event kills the hairiest logic in the current bridges (thread reuse, turn targeting against a shared thread). But the skeleton as declared has **two liveness holes that make it unimplementable as specified**, quietly **regresses five capabilities the current bridges already have**, **re-declares a mechanic the codebase already ships** (turn-start bootstrap), and carries at least three abstractions that can be deleted.

Findings are ordered by severity within each section and numbered globally for reference.

## A. Contract holes — these produce stuck/wrong external state if implemented as declared

### 1. No timeout anywhere — a silently hung provider leaves an ack dangling forever

Orchestration has no turn timeout (only 5s/45s provider-_control_ timeouts in `ProviderCommandReactor`), and if an ACP connection drops silently there is no `thread.session-set` until a server restart triggers `OrphanSessionRecovery`. The current Jira bridge covers this with a configurable 30-minute poll deadline plus a "still working" fallback message (`JiraIssueBridge.ts:504-559`). The skeleton has no deadline concept, yet ntbs.md promises "failure, timeout, or cancellation returns a response that explicitly reports the outcome."

**Fix:** the processor (platform-independent) owns a per-record deadline; on expiry it posts a timeout outcome and marks the record posted — and document that a late real answer is then dropped, or define a supersede rule.

### 2. The event subscription cannot survive a restart, and nothing compensates

`subscribeToT3Events` necessarily rides `OrchestrationEngine.streamDomainEvents`, which is an in-memory PubSub — "hot runtime stream (new events only)" (`orchestration/Services/OrchestrationEngine.ts:52-57`). Any turn that completes while the server (or just the processor fiber) is down emits into the void. `readEvents(fromSequenceExclusive)` exists, but the skeleton stores no cursor anywhere, and the engine's own docstring warns against stale-cursor replay.

**No cursor is needed:** since `resolveT3Outcome` already treats the projection as the source of truth, the startup-recovery pass from finding 1 — re-check the projection for every incomplete record — also closes this hole. Treat the live stream purely as a wake-up signal.

This is also the honest framing of a half-made design choice: the current bridges _poll_ per-delivery, which gets recovery and timeouts almost for free at the cost of 1s ticks. Event-wakeup + projection-truth + startup sweep is a fine steady state, but say so explicitly — the mechanism is currently smeared across `subscribeToT3Events`' docstring.

### 3. Double-posting is possible and undocumented

Crash between a successful `postResponse` and `save(ResponsePosted)` → recovery re-posts. Platforms have no idempotent comment-create, so this is inherent at-least-once delivery. The current bridge has the same window; that is acceptable — but the adapter contract should state which semantics adapters must expect, because it changes what `save` failures mean.

## B. The codebase already has things the skeleton re-declares or ignores

### 4. The turn-start bootstrap already exists as a single command — do not rebuild it from Git primitives

`ThreadTurnStartCommand.bootstrap` covers createThread + prepareWorktree + runSetupScript + first message + turn start (`packages/contracts/src/orchestration.ts:744-803`). Its server-side executor is currently inlined in `ws.ts:816-1168` (`dispatchBootstrapTurnStart`), including subtleties the skeleton would otherwise re-learn the hard way: `thread.meta.update` after worktree creation, polling the projection until the worktree is _visible_ before provider start (`ws.ts:953`), setup-script activity records, `startFromOrigin` fetch/resolve.

The skeleton instead declares its own `createT3Thread`/`startT3Turn` split depending directly on `GitWorkflowService` + `ProjectSetupScriptRunner` + `Crypto` (`processor.ts:74-113`) — i.e., a third copy of the mechanic beside `ws.ts` and `JiraIssueBridge.createThreadForIssue` (which the plan itself calls "a reference, not the desired architecture"). The plan's step 2 — extract the ws.ts mechanic into a service both native clients and NTBS call — is the right move and the skeleton silently dropped it.

**Fix:** do the extraction; the processor's dependency list shrinks to OrchestrationEngine + ProjectionSnapshotQuery + the extracted service. One nuance to encode there: ws.ts _continues_ on worktree-prep failure (`ws.ts:879`), but NTBS must _fail_ the event instead — isolation is an agreed hard requirement (ntbs.md §concurrency). The shared service needs a strictness knob.

### 5. Provenance is first-class in T3 and the skeleton cannot carry it

`SourceChannel` already enumerates `discord`/`github`/`jira`/`slack`/`teams` (`packages/contracts/src/identity.ts:60-73`), `SourceRef`/`SourceLocation` carry issueKey/owner/repo/number/guildId (`identity.ts:75-116`), `ThreadTurnStartCommand` has `source`/`sourceHint` seats (`orchestration.ts:796-801`), threads have `originSource` (`orchestration.ts:443`), and the current bridges stamp it via `buildIntegrationSourceRef` (`identity/stampSource.ts:175`).

`T3Context = { projectId, revision }` (`processor.ts:36-39`) has no seat for any of this, so NTBS-created threads would lose origin badges, participant attribution, and identity-map resolution that native clients already render — a visible regression vs. today's Jira bridge. It also falsifies the architecture doc's "T3 does not receive or interpret platform data" absolutism: T3 already _stores and renders_ platform provenance; what it does not do is interpret it for routing.

**Fix:** add `source`/`sourceHint` to `T3Context` (or the processor's dispatch), and reword the doc's opacity principle to "T3 never interprets platform data for lifecycle/routing decisions."

### 6. `T3Context` is missing everything else a thread needs, with no stated defaulting policy

Thread creation requires `title`, `modelSelection`, `runtimeMode`, `interactionMode` (`orchestration.ts:627-641`). The current bridge resolves model as `project.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection()`, title from the issue summary, runtimeMode `"full-access"` (`JiraIssueBridge.ts:396-399`). Either `T3Context` grows optional overrides (platforms will eventually want them — e.g. a Jira label selecting a model) or the processor owns the defaulting policy; right now neither is written down. Same for `revision` — is it a branch name or pinned SHA, resolved at accept-time or worktree-time? The current bridge resolves `origin/<baseBranch>` at worktree time.

### 7. `snapshot: string` will hit the 120k input cap and silently forecloses attachments

`PROVIDER_SEND_TURN_MAX_INPUT_CHARS = 120_000` (`orchestration.ts:145`) — a captured Jira issue + comment history or a PR diff snapshot can exceed it, and then the dispatch fails and the lifecycle wedges (see finding 1). The processor must own a truncation policy.

Separately, turn messages support image attachments (`ChatAttachment`), and Jira/GitHub/Discord invocations routinely include screenshots; `snapshot: string` forecloses them. Punting is fine — write the exclusion into the lifecycle module so it is a decision, not an accident.

### 8. Actor trust has no home

`classifyJiraActorTrust`/`githubActorTrust` gate who may trigger work, with a "context-only" fallback that _posts a note instead of starting work_. The platform-handler docstring ("determines whether the input should start work", `platform-handler.ts:8-14`) implicitly absorbs trust but never names it, and the context-only path — an outbound platform post with no lifecycle — fits neither handler nor adapter contract as written. It is fine to keep it platform-side and outside the lifecycle; say so explicitly, because it is a security boundary.

## C. Simplifications — things to delete or merge

### 9. `platform-handler.ts` is a vacuous abstraction — delete it

`NTBSPlatformHandler<Input>` is `handle: Input => Effect<void, Error>` (`platform-handler.ts:15-17`). Nothing consumes it polymorphically and nothing ever will — each platform's HTTP route calls its own handler with its own `Input` type; a generic interface over an existential `Input` has no call sites by construction. It is a function type with a ceremony tag factory. The real architecture is two-piece (processor + adapter); the "handler" is just each adapter package's inbound edge, and a comment in `processor.ts` already documents that convention adequately.

### 10. Collapse `ProcessorEvent` — the union wraps two statically-known callers

`{ source: "adapter" } | { source: "t3" }` (`processor.ts:41-50`) has exactly one producer per arm, and the `"t3"` arm's only legitimate producer is the processor's _own_ subscription. Exposing it invites outsiders to inject synthetic T3 events, and `"adapter"` is a misnomer anyway (the platform handler builds it, not the adapter). Replace with `handleRequest(request, t3Context)` plus the internal subscription; tests can fake the engine's stream through the service dependency instead of injecting events through the front door.

Also reconsider exposing `subscribeToT3Events` at all — if callers must wire it, name it for what it is (`run`/`daemon`); its current docstring leaks a private function name (`processT3Event`).

### 11. Justify each of the five states with a distinct recovery action, or cut to three

`ResponseAvailable` as a _persisted_ state buys nothing today: recovery must re-derive the outcome from the projection anyway (finding 5), and dedup only needs "posted". The current stores run on effectively three states (`received`/`processing`/`completed`) plus nullable message IDs. Keep five states only if each maps to a distinct crash-recovery behavior — writing that table down (state → recovery action) is the cheapest way to force findings 1/2/5 to resolution. If a state has no recovery action of its own, it is a log line, not a state.

### 12. Drop the tag factories until something resolves them from context

Adapter → processor → handler is a straight constructor chain assembled once at bootstrap; only the HTTP route plausibly needs a context tag. Three string-keyed generic tag factories (`makeNTBS*Tag(key)`) also deviate from the codebase convention (`class X extends Context.Service<X, Shape>()("t3/…")` with namespaced IDs) and nothing type-checks that two call sites will not collide on a bare key like `"jira"`. If kept, namespace the keys. (`Context.Service<Shape>(key)` is a legitimate effect-smol form, so the factories are _sound_, just probably unnecessary.)

### 13. Design the error taxonomy around retryability, not strings

`AdapterError { reason: string }` / `NTBSProcessorError { reason: string }` erase the one distinction the whole outbox pattern turns on: transient (429, network) vs. permanent (403, deleted comment). The current `JiraAppClient` already encodes retry-vs-fallback decisions (400/404 → try next parent). "Will be refined later" is noted in `adapter.ts` — but retryability is the _first_ refinement, and it changes method signatures, so decide it before adapters exist.

### 14. Do not collapse the outcome to `text` before the adapter sees it

`resolveT3Outcome` returns bare text and `postResponse(event, text)` posts it (`processor.ts:140-145`, `adapter.ts:55-58`). The docs distinguish answer/failure/timeout/cancellation and adapters own platform rendering — yet the one place rendering matters (a failure vs. an answer) arrives pre-flattened, while ack copy is fully adapter-owned. Asymmetric. Pass a small tagged outcome (`{ kind: "answer" | "failure" | "interrupted" | "timeout"; text }`) and let the adapter format.

### 15. Naming/file nits, worth fixing while it is cheap

- `schemas.ts` contains no `effect/Schema` schemas — misleading in a repo where "schema" means that specifically (`packages/contracts` is "schema-only"); call it `lifecycle.ts`.
- Three different things are called "event" in one file (platform events, T3 events, and these persisted _states_ with event-shaped names like `"thread.started"`); the base type `LifecycleEvent` is a state/record, and its docstring still says "NTBSEvent" (`schemas.ts:18`) while the docs say `NtbsEvent` and the state names diverge from the doc's (`acknowledgementPosted` vs `thread.started.acknowledged`).
- Typos: "response tex" (`processor.ts:83`), "idenitifier" (`adapter.ts:52`).
- Casing: `NTBSAdapter` vs the docs' `Ntbs`.

## D. Decisions to make now (cheap in planning, expensive later)

- **Post-response thread policy.** Thread-per-event with no terminal action means worktrees and inbox noise accumulate unboundedly — `WorktreeLifecycle` only cleans on archive, and nobody archives NTBS threads. The docs acknowledge the noise but propose nothing. Decide: auto-settle (or archive) after `ResponsePosted`, keeping worktree-retention rules in one place.
- **Concurrency caps.** A chatty Jira issue or Discord thread can fork-bomb worktrees + provider sessions. The cap/queue/reject policy is platform-independent and belongs in the processor; the current bridge only bounds _recovery_ concurrency (4).
- **In-process vs. remote adapters.** The skeleton is in-process Effect services; Jira/GitHub webhooks fit, but today's Discord integration is an external bot speaking WS with `sourceHint` (`identity/stampSource.ts:2-4`). ntbs.md's own framing ("adapters should be able to obtain an initial state and then receive subsequent changes") describes a _protocol_, not an in-process interface. Building in-process first is fine — but state that the Discord port means either moving the bot in-server or exposing the processor over a transport, so nobody bakes in-process assumptions into the lifecycle store.
- **Ack-before-turn ordering.** The skeleton posts the ack before starting the turn (`processor.ts:117-123`); the plan doc ordered turn-start first. Ack-first is currently _forced_ by finding 2's type constraint and costs a platform round-trip of agent latency on every event. If `acknowledgementMessageId` becomes optional in response states, the ordering becomes free — choose it deliberately rather than inheriting it from the type shape.
- **Snapshot retention.** Adapters persist external user content (snapshots) indefinitely; platforms let users delete messages. The docs punt to adapters — fine, but record it as a known compliance question, and note the current store's ~2000-record cap as prior art.

## What is right (keep it)

- Thread-per-event genuinely deletes the worst code in the current bridges (`resolveLinkedThreadId`, ambiguous-link handling, target-turn discovery against shared threads).
- The adapter surface (`accept`/`save`/`find`/`post*`) is small, in-memory-fakeable, and matches the plan's testing strategy.
- Keeping platform data opaque-generic (`PlatformData<Source, ResponseDestination>`) while the processor owns sequencing is the correct division — every platform-independent behavior identified in the Jira bridge analysis fits it once findings 1–5 are fixed.

## Summary

The skeleton is a good shape wrapped around an incomplete failure model:

1. Fix the recovery story (findings 1, 5), the ack dead-end (2), turn anchoring (3), and timeouts (4) in the contract now.
2. Reuse the bootstrap command and provenance plumbing instead of re-declaring them (7, 8).
3. Delete the platform-handler layer (12).

Update [ntbs-architecture.md](./ntbs-architecture.md) alongside — several findings (3, 8) are places where the skeleton diverged from decisions the docs already got right.
