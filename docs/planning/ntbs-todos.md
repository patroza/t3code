# NTBS todos

The exchange model, ports, processor, and T3 gateway are implemented under `apps/server/src/ntbs/`. This file tracks only what is still open. Findings referenced by id are in `review-01-09.md`.

## Other review items

- [ ] Review user-facing error messages.

## Tests

- [ ] Injectable repository in the processor harness (failures and gates; would also cover `persist` failures and the exchange-lock duplicate re-check, which is otherwise reachable only through a concurrent-first-delivery race).
- [ ] `startTurn` fatal → `ReplyPending`.
- [ ] Bound `awaitStoredTag`/`awaitCalls` with a diagnostic timeout.
- [ ] `ensureWorktree` remaining error branches: `fs.exists`, `localStatus`, and `listRefs` failures; `removeWorktree` with its `fs.remove` fallback also failing; the `locked` stale-registration variant; "isRepo but wrong ref".

## Next

- [ ] Jira port as the first real adapter, replacing the legacy bridge path.
- [ ] SQL `ExchangeRepository`: `sourceUri` primary key, unique `threadId` index (NULLs allowed) — one exchange per thread, both lookups indexed.
- [ ] Wire `makeNTBSProcessor` into the server with a real adapter and SQL repository; verify persistence and recovery across restarts.

## Review fork-specific provenance after the NTBS migration

Keep `SourceChannel`, `SourceRef`, `sourceHint`, `originSource`, and related fork-specific provenance out of the NTBS design. Adapters already retain the platform data needed to connect external messages with T3 work.

After every external platform has moved to NTBS, remove obsolete integration logic. Review provenance fields separately: they also support participant attribution, ownership filters, and source badges in clients, so migration alone does not make them redundant.

## Decide thread archival after testing

Keep NTBS-created T3 threads after their responses are posted for now. Once the workflow has been tested in practice, decide whether completed threads should be archived automatically and under which conditions.

## Inbound triggers and reply delivery

- [ ] Define when an edit counts as a first invocation and which snapshot is accepted when deliveries arrive late or out of order. `sourceUri` deduplicates accepted requests; platform-specific inbound code must decide which events to submit.
- [ ] Decide reply placement for each platform so final delivery works even if acknowledgement fails. For Discord, replying to the invoking message fits the current contract; replying to the acknowledgement requires locating a message whose ID NTBS does not retain.
- [ ] Investigate provider requests for user input: NTBS forwards settled outcomes, so a turn waiting for input may remain active until timeout. Decide how to handle this without relying on interactive platform controls.

## Concurrency choreography

We've got lots of code that does locking, queueing, concurrency bonding for exchanges, etc, etc that is now a bit spread over the whole processor and hard to follow.

Activity handling has since collapsed into one queue-and-worker pipeline inside `run`; what remains spread out is the per-exchange lock and the pass helpers (`resumeExchange`, `tryResumeExchange`, `advanceSavedExchange`).

We need to investigate whether it can be simplified or abstracted to its own module so processor stays as simple as possible and concurrency logic is easier to test and verify.

## Integration tests

- [ ] Against the real `OrchestrationEngine` + sqlite: dispatch `thread.turn.start` through the real engine, then read `getTurnStatus`. The whole design rests on dispatch being synchronous with projection, which `t3gateway.ts:184-186` notes no test in this package would notice if it broke; the test would also have caught the provider-failure retry loop fixed on 2026-09-02.
