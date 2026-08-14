# NTBS directory review

**Status:** review notes (Claude Code, 2026-08-14)
**Scope:** `apps/server/src/ntbs/` — `processor.ts`, `adapter.ts`, `lifecycle.ts`, `test-helpers.ts`, `processor.test.ts`, `processor2.test.ts` — checked against the projection pipeline, decider, provider runtime ingestion, and the planning docs.

Overall the shape is right: the processor/adapter boundary is clean, the outcome lock design is sound, and the recovery model (durable record + turn lookup + `findMatchingResponseMessage`) handles the crash windows it was designed for. The findings below are refinements, ordered by how much I'd want them fixed.

---

## 1. Simplifications

### API and business logic

**S1. `messageStatus` is fiber-local state wearing a Map costume** — `processor.ts:636`
The map has exactly one reader, `checkProgress` (`processor.ts:698`); every other use is a write or delete from the same monitor's own control flow. The progress baseline can live in a local variable inside `monitorT3Turn`, with the initial `TurnStatus` passed in as a parameter. That deletes:

- the `"No monitoring state exists"` error case (`processor.ts:700-704`), which cannot occur except through the map indirection itself;
- the delete/set baseline dance in `checkProgress` (`processor.ts:725-729`) and the second delete in the monitor's `ensuring` (`processor.ts:777`);
- the `TurnStats` / `TurnStatus` name near-collision, since `TurnStatus` mostly dissolves.

If you keep any shared structure, its only genuine job is "is someone already monitoring this message" — a `Set<MessageId>` — which is exactly what bug **B2** needs. So: baseline goes fiber-local, the map becomes a Set used for recovery dedup.

**S2. Three copies of the turn-for-message lookup** — `processor.ts:353-365`, `646-658`, `917-929`
`resolveT3Outcome`, `loadMessageStatus`, and `recoverThread` each do `listByThreadId` → filter on `pendingMessageId === userMessageId` → cardinality check with a hand-built error. Extract one `findTurnForMessage(threadId, userMessageId)` helper. This is also the single place to implement the found-0 handling from bug **B1** — three call sites collapse into one decision point.

**S5. `postAcknowledgement`'s return value is dead contract** — `adapter.ts:43`
The processor discards it (`processor.ts:1061-1070`, `Effect.asVoid`), and the simplified lifecycle no longer stores an acknowledgement message ID. Make it `Effect<void, AdapterError>`; an adapter that needs the ID for its own `findMatchingResponseMessage` heuristics can store it internally. Right now the signature promises a use that doesn't exist.

**S6. Half of `test-helpers.ts` is dead code** — `test-helpers.ts:99-270`
`TestEngine`, `TestAdapterState`, `TestAdapter`, and both derived layers are unexported and unused (only `createGitLayerMock` and `createAdapterRequest` are imported, by `processor.test.ts`). `processor2.test.ts` contains its own — already divergent — copies of the same fakes. Pick one harness (the `processor2.test.ts` one is the better design: state services + `Layer.provideMerge`, and the `threadLookups` queue-as-synchronization trick is good), move it into `test-helpers.ts`, and delete the rest. Fold `processor.test.ts` into the same file while at it: its single test (`processor.test.ts:153-163`) asserts nothing — it passes if `process` doesn't die — and the `eventReceived` Deferred in its adapter is never awaited. The assertions it was meant to make are already enumerated in `docs/planning/processor-testing.md` steps 1–8; write them against the surviving harness.

**S7. Small cuts**

- `process` is a rename of `processAdapterRequest` (`processor.ts:1076-1077`) — define `process` directly.
- `else` + trailing `return` after the early-return dedup branch (`processor.ts:1021-1073`) — flatten.
- `runtimeMode: "full-access"` + `interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE` are hardcoded twice (`processor.ts:309-310`, `847-848`) — one module-level constant pair, which is also where a future per-request override would land.

### Naming and contracts

**N1. `subscribeToT3Events` undersells itself** — `processor.ts:100`, `1117-1123`
It subscribes, recovers stored threads, forks monitors, and then runs forever. Callers wire it as the processor's main loop. Call it `run` (or `start`), and keep the doc comment as is — the comment is accurate, the name isn't.

**N2. `ThreadEvent` is not an event** — `lifecycle.ts:39`
It's the stored record shape (input + T3 ids); the states are `ThreadCreated`/`ResponsePosted` and the union is already correctly named `NTBSLifecycle`. `ThreadRecord` (or `LifecycleBase`) says what it is. Same file: the fields are mutable while everything in `processor.ts` is `readonly` — make the contract types `readonly` too.

**N3. Misleading or stale comments**

- `processor.ts:477-480`: "we're only interested in the last user message that appears in the adapter records" — it's the _original_ user message recorded for the request, and it's the only one the adapter knows. "Last" implies a selection that doesn't happen.
- `lifecycle.ts:32-36`: "The processor creates them from attachment data provided by the adapter" — the processor passes `attachments` through untouched (`processor.ts:1044`). The adapter creates them.
- `adapter.ts:48`: typo "idenitifier".

**N4. `adapter.save` doesn't say it's an upsert or name its key** — `adapter.ts:33-36`
The processor calls `save` twice per lifecycle (created, then posted) and expects the second write to replace the first. Both test adapters guessed "keyed by threadId". State it: "Upserts the record for this request; `sourceUri` (equivalently the T3 thread, they're 1:1) is the identity."

**N5. `snapshot`'s 120k limit names no enforcer** — `lifecycle.ts:27-31`
The processor doesn't validate it. Either say "the adapter must truncate/enforce before calling" or drop the sentence — as written it reads like a checked precondition.

**N6. `NTBSResponse.text` ownership for non-answer types** — `adapter.ts:14-17`
The processor bakes fixed English copy for `failure`/`timeout`/`cancellation` (`processor.ts:393-395`, `404`, `413`, `548-553`). If the intent is that adapters may re-render per platform, say on the type that `type` is the contract and `text` a default the adapter may replace; otherwise every platform ships the processor's prose.

**N7. Error-message style drifts** — e.g. "Problems getting the thread from the projection" (`processor.ts:672`) vs. the "Failed …" convention everywhere else. Cheap consistency win when touching those lines.

**N8. Spell out the acronym once** — none of the three source files says what NTBS stands for; the architecture block at `processor.ts:28` is where "Non-Turn-Based Surfaces" belongs.

---

## 2. Bugs, edge cases, race conditions

**B1. A turn that never materializes leaves the request permanently unanswered (until restart)** — `processor.ts:360-365`, `653-658`
Mechanism, confirmed against the projection code: `thread.turn.start` emits `thread.message-sent` + `thread.turn-start-requested` (decider `planTurnStartEvents`), which writes the pending-start row carrying `pendingMessageId`. If the provider session settles before adopting that row — provider spawn failure, bad model config, runtime error before `turn.started` — the projection **deletes the pending row** (`ProjectionPipeline.ts:1347-1358`, "any settled status abandons an unadopted pending turn start") and no concrete turn row ever exists. From then on both turn lookups find **0** matching turns and hard-error:

- the `thread.session-set(error)` that reports the failure reaches `processT3Event`, which calls `resolveT3Outcome`, gets the "Expected exactly one turn, found 0" error, logs a warning, and moves on — the failure outcome is never posted;
- the monitor's `loadMessageStatus` fails the same way, exhausts its 3 retries, and the monitor dies.

Net: the platform user gets the acknowledgement and then silence, until a server restart lets `recoverThread`'s found-0 branch restart the turn. The same hole opens if a user deletes the NTBS thread from the T3 UI mid-run (`deleteByThreadId` removes all turn rows).

Fix direction, in the single helper from S2: treat found-0 as a state, not a violation. Load the thread; session `null`/`starting`/`running` → still pending (return null / `stats: null`); session settled → terminal failure outcome ("T3 could not start work on this request", with `session.lastError`); thread gone from the projection → cancellation. Posting a response flips the record to `thread.response.posted`, so restart-recovery correctly won't retry it. The live path should _post failure_, not restart the turn — restarting on a spawn failure would loop; the bounded once-per-boot retry in recovery is the right place for retries to live.

**B2. Startup race: a request processed while recovery loads gets two monitors** — `processor.ts:1092-1115`, `912-981`
`loadThreadsAwaitingResponse` snapshots all `thread.created` records after the subscription starts. Any request that `process` handled before that load — record saved, monitor forked, still running — is also in the recovery list, so `recoverThread` sets a fresh baseline into the shared `messageStatus` entry and forks a **second** monitor for the same message. Consequences are contained (the outcome lock and state checks prevent double posting) but real: duplicated polling, and when the turn finishes, whichever monitor deletes the map entry first makes the other's next `checkProgress` fail with "No monitoring state exists" → 3 futile retries → a logged-error death that looks like a genuine failure.

There's also a narrower cousin: `recoverThread`'s found-0 branch can re-dispatch `thread.turn.start` if the recovery load lands in the small window between `adapter.save` and `startT3Turn` inside `process` (`processor.ts:1039-1044`). Same messageId, so the projection largely coalesces it, but it's the same root cause.

Fix: guard recovery internally — skip records whose `sourceUri` is in `inFlightRequests` (covers the save→ack span) or whose message is in the active-monitor `Set` from S1 (covers the rest of the turn's lifetime). Note that "wire startup so recovery finishes before webhooks go live" is _not_ currently expressible: `subscribeToT3Events` never returns, and nothing signals recovery completion. The internal guard avoids inventing that signal.

**B3. The 3-minute no-progress timeout will kill healthy turns** — `processor.ts:734-736`
`12 × 15s` of no _projected_ progress interrupts the turn. `getTurnStats`'s own doc comment concedes the limitation: buffered output, hidden reasoning, and provider work that produces no projected event are invisible. The concrete everyday case: a single long tool execution — an install, build, or test suite taking >3 minutes — projects an activity when the call starts and then nothing until it returns, with no assistant text streaming in between. The monitor will interrupt mid-build and post a timeout for a turn that was fine. The `TODO: config` is already there; beyond making it configurable, the default needs to be sized for agent work (10+ minutes), because there is no cheap signal that distinguishes "provider hung" from "tool call still running" at this altitude.

**B4. Monitor death is permanent and quiet** — `processor.ts:743-754`
A transient projection failure lasting ~45s (4 attempts, 15s apart) kills the monitor for that request; only a log line records it. Outcome posting still works via the event path, so the visible loss is just stall protection — but that's precisely the protection you can't tell is missing. Consider retrying the _load_ indefinitely with backoff and reserving monitor death for the genuinely-inconsistent-state errors. Low urgency, cheap to do while implementing B1 (which removes the most common source of these deaths).

**B5. Crash window between thread creation and `adapter.save` orphans a thread** — `processor.ts:1025-1041`
The architecture doc's original lifecycle persisted an `accepted` state _before_ touching T3; the simplified lifecycle (deliberately, and I agree with the cut) saves only after `createT3Thread` succeeds. Cost: a crash in that window leaves a T3 thread + worktree with no adapter record, and the redelivery creates a second thread. That's acceptable at-least-once behavior — but it contradicts the plan doc's "persist the accepted lifecycle state before starting T3 work", so record the decision in the `processor.ts` header comment (or the plan doc) so it reads as chosen, not missed.

**B6. Recovery assumes the turn projection is caught up at startup** — `processor.ts:917-931`
If projections hydrate asynchronously relative to when wiring calls `subscribeToT3Events`, `recoverThread` can read a stale 0-turn view and re-dispatch `thread.turn.start`. Reusing the recorded `userMessageId` makes this nearly idempotent, but two adopted turns for one message would trip every "exactly one" check and wedge the request. Since the wiring doesn't exist yet, this is a one-line requirement to write down wherever the processor gets started: projection catch-up happens-before `subscribeToT3Events`.

**B7. Head-of-line blocking on the event loop** — `processor.ts:1079-1090`
`Stream.runForEach` processes session-set events sequentially, and `processT3Event` holds the event loop through adapter lookups and — under the outcome lock — platform API calls. One slow Discord/Jira call delays outcome posting for every other request on the same adapter (adapters are isolated from each other; each has its own processor). Fine for v1 volumes; worth a comment so the serialization is visibly a choice, and the fix (fork per event once it matters) is understood.

Related, no action needed: `postResponse` posting successfully and then failing to `save` leaves the record `thread.created` with no further session-set to retry it in-lifetime; restart-recovery resolves it via `findMatchingResponseMessage` without re-posting. That's the designed net and it holds.

---

## Reviewed and deliberately not flagged

- `ensureUniqueOutcome` + per-message semaphore + `markResponsePosted` cleanup: correct, including the re-created-lock guard on delete.
- Subscription-before-recovery ordering in `subscribeToT3Events`: right pattern for a hot stream; no missed-event window.
- `resolveWorktreeBase`: fetch-failure and unresolvable-ref fallbacks are sensible, and "never fails, let worktree creation carry the real git error" is the right call.
- Worktree cleanup on `thread.create` failure, including the documented accepted leak of the temporary branch ref.
- `findMatchingResponseMessage` consulted on every post: cheap, and it's the idempotency net for the post-then-crash window — keep it in the common path.
- Posting the timeout response before interrupt confirmation (a late real answer gets discarded): a defensible product trade-off, already serialized correctly.
