# NTBS adversarial review — 2026-09-01

**Scope:** `apps/server/src/ntbs/` (`exchange.ts`, `ExchangeRepository.ts`, `adapter.ts`, `t3gateway.ts`, `processor.ts`) and the four test files. Reviewed against the real T3 internals the gateway depends on (`ProjectionPipeline.ts`, `decider.ts`, `OrchestrationEngine.ts`, `ProjectSetupScriptRunner.ts`, git driver) and against `ntbs-architecture.md` / `ntbs-todos.md`.

**Method:** one manual pass plus three independent adversarial reviewers with separate lenses (processor/exchange soundness, gateway vs T3 internals, test-suite adequacy). Findings below are deduplicated and ranked. Every claim was verified against source; line numbers are as of commit `c80ee1bb8`.

## Verdict in one paragraph

The model and the orchestration loop are sound. The five-state exchange, the pure deciders, observe-before-act, the per-source lock, the claim idempotency, and the recovery/sweep loop all hold up under interruption and crash analysis, and the reviewers found no way to create two threads or post two replies for one request. The problems are at the seams with T3: three assumptions the gateway makes about T3 internals are false in realistic failure modes, and each one turns a failure that should end in a failure reply into either silence or an infinite retry. Those must be fixed before the first real adapter, because every one of them is triggered by something a user will do (delete a thread, name a wrong branch, have a provider that fails to launch). The test suite is thorough for the happy and transient-failure paths of the processor and for gateway classification, but it never exercises the sweeper, never tests against the real engine, and in one place pins the opposite of the documented contract.

## Part 1 — Implementation soundness

### HIGH

**H2. A rejected request produces silence, and the documented contract says otherwise.**
`processor.ts:371-373` maps `FatalError` from `planCoordinates` (branch not on origin, project missing, no `origin` remote) to `NTBSProcessorError` with nothing persisted. `t3gateway.ts:72` claims the processor "converts that into a reply-pending failure"; it cannot, because `ExchangeBase` requires the coordinates that just failed. The user who typed a wrong branch name never hears back; the webhook errors, the platform redelivers, and each redelivery does a full `git fetch`.
Fix: decide who owns this reply. Either a typed `NTBSRequestRejected` error the inbound code must render to the platform, or a `RequestRejected` state with `t3: null` that flows through normal delivery. Fix the comment on `t3gateway.ts:72` either way.

**H3. Crash after `thread.create` but before setup scripts skips setup permanently; fatal cleanup orphans a thread.**
Provisioning order is worktree → `thread.create` with the final `worktreePath` → scripts (`t3gateway.ts:690-765`). `getThreadStatus` (`:480-491`) reports `present` from the shell alone, so recovery after a crash in that window decides `record-thread-created` and never runs setup. On a `FatalError` after `thread.create`, `tapError` (`:767-773`) removes the worktree but leaves the T3 thread pointing at the deleted path; the provider then spawns with a missing cwd and errors, which the gateway now reports as a failure reply (see "Resolved"). `ntbs-todos.md` ("Settled gateway contracts") specified `worktreePath: null` on create, a blocking setup, then `thread.meta.update` as the durable readiness marker. That design was not implemented and the comment on `t3gateway.ts:163` ("each skipped if already done") is false for setup.
Fix: implement the documented readiness marker, or at minimum dispatch `thread.delete` on fatal cleanup.

**H4. Setup scripts do not block and their failure is never observed.**
`ProjectSetupScriptRunner.runForThread` (`ProjectSetupScriptRunner.ts:141-182`) opens a terminal, writes `command\r`, returns `started`. The comment at `t3gateway.ts:749-752` ("Script failures are … fatal") is false: only terminal open/write failures are errors. `startTurn` can run while `pnpm install` is still executing. `ntbs-todos.md` required `runForThreadAndWait`; it was never added.
Fix: add the blocking runner with a timeout, or rewrite the comment and accept the race explicitly.

**H5. Head-of-line blocking on the activity loop, fed by an unbounded firehose.**
`threadActivity` (`t3gateway.ts:638-644`) forwards every thread event system-wide, token deltas included, from `PubSub.unbounded` (`OrchestrationEngine.ts:92`). `Stream.runForEach` (`processor.ts:393`) processes pings strictly sequentially, each taking the per-source lock and running port calls with no timeout anywhere. One `postReply` hanging on Jira for 60 s parks every other exchange's completion ping behind it while the pubsub buffer grows without bound. A ping on a `request-claimed` exchange runs `provisionThread` (git fetch, worktree, scripts) inline in the loop.
Fix: (a) narrow the filter to session/turn lifecycle events; (b) make pings non-blocking (record "dirty" and let the holder re-drive, or `withPermitsIfAvailable`); (c) `Effect.timeout` on every adapter and gateway call, classified retryable.

### MEDIUM

**M1. `process` can fail after the claim and the caller cannot tell.** `processor.ts:375-376`: `persist(claimed)` succeeds, `advanceExchange` fails transiently, `process` returns an error. The doc says it "returns once the exchange is claimed". A webhook handler will post its own error while the sweeper later posts the real reply. Also heavy provisioning runs inside the webhook request fiber. Fix: after the claim, log-and-succeed (as `run` does) or fork the advance into `run`'s scope.

**M2. `provisionThread` retries forever when the thread id was deleted.** `t3gateway.ts:729-746` swallows every dispatch failure into `RetryableError` when the thread is absent. `requireThreadAbsent` (`commandInvariants.ts:147-165`) rejects ids in `deletedThreadIds`, so a user deleting the NTBS thread mid-provisioning makes every pass fail with an invariant error that is retried each minute. `startTurn` (`:617-629`) classifies the same error as fatal. Fix: mirror `startTurn`: invariant error and thread absent → `FatalError`.

**M3. No deadline for any non-terminal state; the sweeper retries forever with no backoff.** A turn T3 calls `active` forever (agent hung, token limit), a provisioning that fails transiently every minute (repeated `git fetch`), a platform that is down for a day: all stay non-terminal indefinitely and `findNonTerminalExchanges` grows monotonically. `ntbs-architecture.md` says the heuristics are undefined; the sweeper shipped anyway. Fix: add `claimedAt`/`updatedAt` and an attempt counter to `ExchangeBase`; per-state deadlines in the decider (`active` past N → `thread.turn.interrupt`, which yields the existing cancellation path); exponential backoff.

**M4. Stored replies carry raw `cause: unknown` and leak internal text.** `processor.ts:137-144` stores `FatalError.cause` verbatim: error instances, git results, possibly cyclic. A real repository will JSON-encode it; a throw there fails `persist` and strands the exchange. `text: failure.reason` is what gets posted to the platform ("T3 rejected the turn start for thread <uuid>"). Gateway replies write `cause: null` contrary to the structured causes in `ntbs-todos.md`. Fix: type `cause` as a JSON-safe schema, convert at the boundary, and separate user-facing text from diagnostics.

**M5. Nothing is wired.** No SQL `ExchangeRepository`, no real adapter, no consumer of `makeNTBSProcessor` outside tests. The "durable" in the design is the in-memory HashMap today. Not a defect, but it bounds what this review can say: the persistence assumptions in M4 and the index needs in L2 are untested.

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

1. **The sweeper has never run in a test.** `it.effect` provides a `TestClock`, so `Effect.delay("1 minute")` never fires and every `run` test interrupts first. The design's backstop for missed pings, and a sweep racing an activity ping on the same source, is one `TestClock.adjust("1 minute")` away.
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

1. M2 + M3 together: they are one problem, "T3 said no or nothing, and NTBS retries forever". Add an attempt counter and timestamps to `ExchangeBase` and make invariant rejections fatal in `provisionThread`.
2. H3 + H4: implement the documented readiness marker (`worktreePath: null` → blocking setup → `thread.meta.update`) and make `getThreadStatus` honour it. Fix the `getThreadStatus` test to match.
3. H2 + M1: define who posts the reply for a request T3 refuses before a claim exists, and make `process` return once claimed.
4. H5: narrow the activity filter and add timeouts. Non-blocking pings can wait until the platform adapter exists and shows real latency.
5. Tests: sweeper via `TestClock`, one real-engine integration test, injectable failing repository, `startTurn` fatal path, and bound `awaitStoredTag`.
6. M4 before the SQL repository lands, so `cause` never hits the database unserialized.
