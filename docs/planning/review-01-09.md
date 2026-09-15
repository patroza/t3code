# NTBS adversarial review — 2026-09-01

**Scope:** `apps/server/src/ntbs/` (`exchange.ts`, `ExchangeRepository.ts`, `adapter.ts`, `t3gateway.ts`, `processor.ts`) and the four test files. Reviewed against the real T3 internals the gateway depends on (`ProjectionPipeline.ts`, `decider.ts`, `OrchestrationEngine.ts`, `ProjectSetupScriptRunner.ts`, git driver) and against `ntbs-architecture.md` / `ntbs-todos.md`.

**Method:** one manual pass plus three independent adversarial reviewers with separate lenses (processor/exchange soundness, gateway vs T3 internals, test-suite adequacy). Findings below are deduplicated and ranked. Every claim was verified against source; line numbers are as of commit `c80ee1bb8`.

## Verdict in one paragraph

The remaining gateway concerns center on setup readiness: recovery can skip setup, and starting a script does not establish that it finished successfully. The activity loop still consumes every thread event sequentially, although adapter and gateway calls now have timeouts. Tests cover deadline handling, timeout recovery through sweeps and activity, and lock release; real-engine integration and setup-readiness coverage remain open.

## Part 1 — Implementation soundness

### HIGH

**H3. Crash after `thread.create` but before setup scripts skips setup permanently; fatal cleanup orphans a thread.**
Provisioning order is worktree → `thread.create` with the final `worktreePath` → scripts (`t3gateway.ts:690-765`). `getThreadStatus` (`:480-491`) reports `present` from the shell alone, so recovery after a crash in that window decides `record-thread-created` and never runs setup. On a `FatalError` after `thread.create`, `tapError` (`:767-773`) removes the worktree but leaves the T3 thread pointing at the deleted path; the provider then spawns with a missing cwd and errors, which the gateway now reports as a failure reply (see "Resolved"). `ntbs-todos.md` ("Settled gateway contracts") specified `worktreePath: null` on create, a blocking setup, then `thread.meta.update` as the durable readiness marker. That design was not implemented and the comment on `t3gateway.ts:163` ("each skipped if already done") is false for setup.
Fix: implement the documented readiness marker, or at minimum dispatch `thread.delete` on fatal cleanup.

**H4. Setup scripts do not block and their failure is never observed.**
`ProjectSetupScriptRunner.runForThread` (`ProjectSetupScriptRunner.ts:141-182`) opens a terminal, writes `command\r`, returns `started`. The comment at `t3gateway.ts:749-752` ("Script failures are … fatal") is false: only terminal open/write failures are errors. `startTurn` can run while `pnpm install` is still executing. `ntbs-todos.md` required `runForThreadAndWait`; it was never added.
Fix: add the blocking runner with a timeout, or rewrite the comment and accept the race explicitly.

**H5. The activity loop processes every thread event sequentially.**
`threadActivity` in `t3gateway.ts` forwards every thread event system-wide, including token deltas. `Stream.runForEach` in `processor.ts` handles these pings sequentially, taking the source lock and advancing the exchange inline. Adapter and gateway calls now have timeouts, but a slow call or a wait for another attempt's lock still delays other exchanges' pings while events accumulate in the unbounded buffer.
Fix: narrow the filter to session/turn lifecycle events. If measured latency warrants it, coalesce pending pings or avoid waiting on occupied source locks while ensuring the exchange is driven again.

### MEDIUM

**M1. `process` can fail after the claim and the caller cannot tell.** `processor.ts:375-376`: `persist(claimed)` succeeds, `advanceExchange` fails transiently, `process` returns an error. The doc says it "returns once the exchange is claimed". A webhook handler will post its own error while the sweeper later posts the real reply. Also heavy provisioning runs inside the webhook request fiber. Fix: after the claim, log-and-succeed (as `run` does) or fork the advance into `run`'s scope.

**M4. Failure replies expose internal wording.** Stored failure causes are now structured rather than raw errors, but `toRejected` still copies `rejection.reason` into the platform reply. Gateway reasons can contain implementation details such as thread UUIDs. Fix: separate user-facing failure text from diagnostic wording.

**M5. Nothing is wired.** No SQL `ExchangeRepository`, no real adapter, no consumer of `makeNTBSProcessor` outside tests. The "durable" in the design is the in-memory HashMap today. Not a defect, but it bounds what this review can say: SQL persistence and the index needs in L2 are untested.

### LOW

**L1. A defect in the activity subscription kills it silently.** `processor.ts:395-401` catches typed errors only; a defect in `findByThreadId` ends the forked fiber and `run` keeps sweeping, so failures show as one-minute latency with no log. Fix: `Effect.catchCause` + log, and restart the subscription.

**L2. In-memory repository is O(n) per event** (`ExchangeRepository.ts:52-62`, `82-96`) and, per H5, that is every token delta. Fine for tests; the SQL repository needs an index on `threadId` and unique constraints on both keys.

**L3. Worktree branch token is 8 hex chars and T3 renames it on the first turn.** `buildTemporaryWorktreeBranchName` (`packages/shared/src/git.ts:95-105`) slices to 8 chars, and `ProviderCommandReactor.ts:928-960` renames temporary branches. The comment at `t3gateway.ts:464` ("a stray branch points back at its thread") is false, and a collision would make `ensureWorktree` adopt another thread's branch. Use the full UUID with a non-temporary prefix.

**L4. `resolveRemoteTrackingCommit` fatal classification is broader than "branch missing".** `t3gateway.ts:306-318`: any non-zero git exit (index.lock, corrupt ref) becomes "Branch does not exist on origin". Acceptable, but say so in the comment.

**L5. `runtimeMode: "full-access"` for externally-triggered work.** It is already the engine default and bypasses nothing extra, but it is the one place a policy hook for untrusted input would go. Note it; do not solve it now.

### Verified sound

- `withExchangeLock` under interruption: waiter cleanup, `callers` bookkeeping, and the `get(sourceUri) === lock` guard are correct; no deadlock path exists. Wake-up is not FIFO but every caller is idempotent.
- Claim idempotency, concurrent-delivery serialization, forward-only constructors, `ReplyRejected` → `Undeliverable`, ack posted once after `ThreadCreated` is persisted.
- Read-your-writes at activity time holds: the engine publishes to the pubsub strictly after the SQL transaction that appends events and projects (`OrchestrationEngine.ts:174-218`). `pendingMessageId` survives completed/error/interrupted transitions on the happy path via the `...existingTurn.value` spreads.
- Sweeper never overlaps itself; sweep and activity on the same exchange serialize under the lock.
- `createWorktree` argument mapping, `deriveWorktreePath`, `localStatus().refName`, `listRefs` substring semantics compensated by the exact `some(...)` check.

## Part 2 — Test suite

### Gaps that matter

1. **A sweep racing an activity ping on the same exchange still needs coverage.** Sweeper recovery after a timeout is now tested; simultaneous sweep and activity handling is a separate case.
2. **No integration test against the real `OrchestrationEngine` + sqlite.** The whole design rests on dispatch being synchronous with projection; `t3gateway.ts:184-186` says "no test in this package would notice" if that broke. One test that dispatches `thread.turn.start` through the real engine and reads `getTurnStatus` would pin it, and would have caught the provider-failure retry loop fixed on 2026-09-02 (see "Resolved").
3. **`getThreadStatus` test pins the opposite of the documented contract.** `t3gateway.test.ts:955` asserts `present` with a mock whose `worktreePath` is `null`; `ntbs-todos.md` says that must be `missing`. Either the doc or the test is wrong, and today the code follows the test (H3).
4. **Uncovered processor branches:** `startTurn` `FatalError` → `ReplyPending` (`processor.ts:241-246`); `persist` failure (reachable via two requests planned onto one `threadId`); `findByThreadId` / `findNonTerminalExchanges` failures (harness hard-wires the in-memory repo, so no failing repository can be injected); recovery racing activity for the same exchange; `findPostedReply` transient failure followed by a retry that repeats discovery; a burst of pings during an active turn proving no duplicate `postReply`.
5. **Uncovered gateway branches:** `provisionThread` dispatch payload and `deriveWorktreePath` output are never asserted; `ensureWorktree` error branches (`fs.exists`, `localStatus`, `removeWorktree` → `fs.remove` fallback, `listRefs`, "isRepo but wrong ref", the `locked` stale-registration variant); `getProject` failing inside `provisionThread`; `getThreadShellById` failing inside the dispatch-failure re-check; no test asserts `.cause` is preserved; `startTurn` payload test (`t3gateway.test.ts:1827`) omits `type`, so a `thread.create` carrying a message would pass; `threadActivity` (`:1939`) uses a `session-set` event, which satisfies both the shipped filter and the narrower documented one, so it cannot tell them apart.

### Weak tests

- `processor.test.ts:379, 441, 586, 658`: assert `exit._tag === "Failure"` without checking which step failed.
- `processor.test.ts:300-350`: "no further calls" guarded by a single `Effect.yieldNow`; passes if the wrong call is one scheduler tick late. Same pattern at `:508, 577, 649, 723, 780, 796, 1025, 1241, 1304`. Works because every mock is synchronous; the first `Effect.sleep` in the processor path makes these vacuous.
- `processor.test.ts:1209-1268`: the run fiber is interrupted right after the first post attempt, so "stays ReplyPending" holds whether or not the `AdapterError` was observed.
- `t3gateway.test.ts:927-980`: obtains coordinates via `planCoordinates` (needless coupling) and never asserts `getThreadShellById` received the stored thread id.
- `t3gateway.test.ts:624`: `threadId: expect.any(String)` although the UUID mock is deterministic.

### Harness risks

- `awaitStoredTag` (`processor.test.ts:196-207`) is an unbounded `yieldNow` spin. On regression it never returns and the only signal is vitest's 5 s timeout with no diagnostic. Wrap in `Effect.timeout`, or signal a `Deferred` from a repository wrapper's `upsert`.
- `withProcessor` interrupts the `run` fiber after the expects, so a failing assertion leaks the fiber.
- Recovery order over the HashMap is nondeterministic; tests correctly filter per source today, but `:1394` reads `calls[0]` and becomes order-sensitive the moment a second exchange is stored before `run`.

### What is well covered

Exchange deciders and transitions (exhaustively enumerated); repository conflict and atomicity rules; processor claim/dedup/lock semantics including interruption; transient-failure retries for provision, turn start, reply post, turn status; `Undeliverable`; discovered-reply short circuit; per-exchange isolation in recovery and activity; `planCoordinates` and `getTurnStatus` classification including error/interrupted replies.

### Stale checklist

`ntbs-todos.md` marks "findPostedReply retry" and "recovery racing activity" as done; neither test exists. Its gateway checklist still describes `T3Rejected`/`T3GatewayError`, `runForThreadAndWait`, `thread.meta.update` and path-based readiness, none of which match the shipped gateway. Treat it as an unreconciled design doc, not a coverage record, and reconcile it in one of the two directions.

## Resolved

- **2026-09-02 — provider fails to launch → infinite turn re-dispatch.** T3 deletes the pending turn-start row when a session settles without adopting it, so `getTurnStatus` answered `missing` and the sweeper restarted the turn every minute. `getTurnStatus` now loads the thread detail when no turn matches: our user message present plus session status `error` becomes a failure reply with `session.lastError`; a missing thread becomes a failure reply; otherwise still `missing`. Verified against `ProviderRuntimeIngestion.ts:1676-1700` (both `session.state.changed(error)` and `turn.completed(failed)` map to `error`; `session.exited` maps to `stopped` and correctly re-dispatches). Pinned by three new tests in `t3gateway.test.ts`.

## Recommended order

1. H3 + H4: implement the documented readiness marker (`worktreePath: null` → blocking setup → `thread.meta.update`) and make `getThreadStatus` honour it. Fix the `getThreadStatus` test to match.
2. M1: decide how `process` should return after recording a request when subsequent work fails, and whether that work belongs in the caller's fiber.
3. H5: narrow the activity filter. Non-blocking pings can wait until the platform adapter exists and shows real latency.
4. Tests: one real-engine integration test, injectable failing repository, `startTurn` fatal path, sweep racing activity, and bound `awaitStoredTag`.
5. M4: separate user-facing rejection messages from diagnostics before a real adapter posts them.
