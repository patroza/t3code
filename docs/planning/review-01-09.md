# NTBS adversarial review — 2026-09-01

**Scope:** `apps/server/src/ntbs/` (`exchange.ts`, `ExchangeRepository.ts`, `adapter.ts`, `t3gateway.ts`, `processor.ts`) and the four test files. Reviewed against the real T3 internals the gateway depends on (`ProjectionPipeline.ts`, `decider.ts`, `OrchestrationEngine.ts`, `ProjectSetupScriptRunner.ts`, git driver) and against `ntbs-architecture.md` / `ntbs-todos.md`.

**Method:** one manual pass plus three independent adversarial reviewers with separate lenses (processor/exchange soundness, gateway vs T3 internals, test-suite adequacy). Findings below are deduplicated and ranked. Every claim was verified against source; line numbers are as of commit `c80ee1bb8`.

## Part 1 — Implementation soundness

### LOW

**L5. `runtimeMode: "full-access"` for externally-triggered work.** It is already the engine default and bypasses nothing extra, but it is the one place a policy hook for untrusted input would go. Note it; do not solve it now.

### Deferred

**Setup recovery.** A crash between thread creation and setup launch can cause recovery to skip setup. Revisit when T3 exposes setup completion; NTBS will not introduce a separate setup lifecycle.

## Part 2 — Test suite

### Gaps that matter

1. **A sweep racing an activity ping on the same exchange still needs coverage.** Sweeper recovery after a timeout is pinned, and "waits for an in-flight recovery pass before checking the same exchange" pins startup recovery meeting a ping; the sequential sweep meeting a ping is still a separate case.
2. **No integration test against the real `OrchestrationEngine` + sqlite.** The whole design rests on dispatch being synchronous with projection; `t3gateway.ts:184-186` says "no test in this package would notice" if that broke. One test that dispatches `thread.turn.start` through the real engine and reads `getTurnStatus` would pin it, and would have caught the provider-failure retry loop fixed on 2026-09-02 (see "Resolved").
3. **Uncovered processor branches:** `startTurn` `FatalError` → `ReplyPending` (`processor.ts:241-246`); `persist` failure (reachable via two requests planned onto one `threadId`); `findByThreadId` / `findNonTerminalExchanges` failures (harness hard-wires the in-memory repo, so no failing repository can be injected); `findPostedReply` transient failure followed by a retry that repeats discovery; a burst of pings during an active turn proving no duplicate `postReply`.
4. **Uncovered gateway branches:** `getProject` failing inside `provisionThread`; `deriveWorktreePath` output is never asserted; `ensureWorktree` error branches (`fs.exists`, `localStatus`, `removeWorktree` → `fs.remove` fallback, `listRefs`, "isRepo but wrong ref", the `locked` stale-registration variant); `startTurn` payload test omits `type`, so a `thread.create` carrying a message would pass.

### Weak tests

- `processor.test.ts:300-350`: "no further calls" guarded by a single `Effect.yieldNow`; passes if the wrong call is one scheduler tick late. Same pattern at `:508, 577, 649, 723, 780, 796, 1025, 1241, 1304`. Works because every mock is synchronous; the first `Effect.sleep` in the processor path makes these vacuous.
- `processor.test.ts:1209-1268`: the run fiber is interrupted right after the first post attempt, so "stays ReplyPending" holds whether or not the `AdapterError` was observed.
- `t3gateway.test.ts:927-980`: obtains coordinates via `planCoordinates` (needless coupling) and never asserts `getThreadShellById` received the stored thread id.
- `t3gateway.test.ts:624`: `threadId: expect.any(String)` although the UUID mock is deterministic.

### Harness risks

- `awaitStoredTag` and `awaitCalls` are unbounded `yieldNow` spins. On regression they never return and the only signal is vitest's 5 s timeout with no diagnostic. Wrap in `Effect.timeout`, or signal a `Deferred` from a repository wrapper's `upsert`.
- `withProcessor` interrupts the `run` fiber after the expects, so a failing assertion leaks the fiber.
- Recovery order over the HashMap is nondeterministic; tests correctly filter per source today, but `:1394` reads `calls[0]` and becomes order-sensitive the moment a second exchange is stored before `run`.

### What is well covered

Exchange deciders and transitions (exhaustively enumerated); repository conflict and atomicity rules; processor claim/dedup/lock semantics including interruption; transient-failure retries for provision, turn start, reply post, turn status; `Undeliverable`; discovered-reply short circuit; per-exchange isolation in recovery and activity; `planCoordinates` and `getTurnStatus` classification including error/interrupted replies.

## Resolved

- **2026-09-02 — provider fails to launch → infinite turn re-dispatch.** T3 deletes the pending turn-start row when a session settles without adopting it, so `getTurnStatus` answered `missing` and the sweeper restarted the turn every minute. `getTurnStatus` now loads the thread detail when no turn matches: our user message present plus session status `error` becomes a failure reply with `session.lastError`; a missing thread becomes a failure reply; otherwise still `missing`. Verified against `ProviderRuntimeIngestion.ts:1676-1700` (both `session.state.changed(error)` and `turn.completed(failed)` map to `error`; `session.exited` maps to `stopped` and correctly re-dispatches). Pinned by three new tests in `t3gateway.test.ts`.

## Recommended order

1. Tests: one real-engine integration test, injectable (failing/gated) repository, `startTurn` fatal path, sweep racing activity, and bound `awaitStoredTag`/`awaitCalls`.
