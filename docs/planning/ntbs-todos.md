# NTBS todos

The exchange model, ports, processor, and T3 gateway are implemented under `apps/server/src/ntbs/`. This file tracks only what is still open. Findings referenced by id are in `review-01-09.md`.

## Classify provisioning failures and bound calls (M2, M3)

Per-state deadlines are implemented and checked during reconciliation; they do not interrupt a hung call. Backoff was left out on purpose. Deleted thread IDs can now be recreated, so M2's original permanent rejection scenario no longer applies.

- [ ] `provisionThread`: preserve the recovery check after dispatch failure, but keep a failed lookup retryable instead of treating it as confirmed absence. If absence is confirmed, classify an invariant rejection as `FatalError` and infrastructure failures as `RetryableError`.
- [ ] Bound adapter and gateway calls (shared with H5) and ensure repeated status-read failures cannot bypass the existing deadline checks. A timed-out dispatch may still commit later; recovery must observe the result before retrying.

M2: if thread.create is rejected because the project vanished after we read it, NTBS currently
turns that definite “no” into a retry; it waits for the 15-minute deadline instead of recording a
failure reply immediately. It also treats a failed “does the thread exist?” lookup as if the
thread definitely does not exist, which loses useful uncertainty.

M3: the deadline only runs after NTBS has successfully checked the current state. If that check,
dispatch, or adapter call hangs or keeps failing, execution never reaches the deadline decision,
so the exchange can remain stuck despite having a configured expiry.

## Durable readiness marker (H3, H4)

Provisioning today is worktree → `thread.create` with the final path → fire-and-forget setup script. `getThreadStatus` reports `present` from the thread shell alone, so a crash between `thread.create` and setup skips setup permanently, and a fatal cleanup leaves a thread pointing at a removed worktree.

- [ ] Create the thread with `worktreePath: null`, ensure the worktree, run setup and wait, then dispatch `thread.meta.update` with the final path.
- [ ] Add `ProjectSetupScriptRunner.runForThreadAndWait` backed by `ProcessRunner`, with a timeout and bounded diagnostic output; failure or timeout is `RetryableError`.
- [ ] `getThreadStatus` reports `present` only with a non-null `worktreePath`. Fix the test that pins the opposite.
- [ ] On `FatalError` after `thread.create`, cleanup also dispatches `thread.delete`.
- [ ] Setup is at-least-once; scripts must be idempotent.

## Other review items

- [ ] H5: narrow `threadActivity` to session/turn lifecycle events; `Effect.timeout` on every adapter and gateway call.
- [ ] L3: worktree branch uses the full thread UUID with a non-temporary prefix so T3 does not rename it.

## Tests

- [ ] Sweeper via `TestClock`.
- [ ] One real-engine integration test for `startTurn` → `getTurnStatus`.
- [ ] Injectable failing repository in the processor harness.
- [ ] `startTurn` fatal → `ReplyPending`.
- [ ] Bound `awaitStoredTag` with a timeout.
- [ ] `ensureWorktree` error branches: `fs.exists`, `localStatus`, `removeWorktree` fallback, `listRefs`, "isRepo but wrong ref", stale locked registration.

## Next

- [ ] Jira port as the first real adapter, replacing the legacy bridge path.
- [ ] SQL `ExchangeRepository` with an index on `threadId` and unique constraints on both keys.

## Review fork-specific provenance after the NTBS migration

Keep `SourceChannel`, `SourceRef`, `sourceHint`, `originSource`, and related fork-specific provenance out of the NTBS design. Adapters already retain the platform data needed to connect external messages with T3 work.

After every external platform has moved to NTBS, remove obsolete integration logic. Review provenance fields separately: they also support participant attribution, ownership filters, and source badges in clients, so migration alone does not make them redundant.

## Decide thread archival after testing

Keep NTBS-created T3 threads after their responses are posted for now. Once the workflow has been tested in practice, decide whether completed threads should be archived automatically and under which conditions.

## Inbound triggers and reply delivery

- [ ] Define when an edit counts as a first invocation and which snapshot is accepted when deliveries arrive late or out of order. `sourceUri` deduplicates accepted requests; platform-specific inbound code must decide which events to submit.
- [ ] Decide reply placement for each platform so final delivery works even if acknowledgement fails. For Discord, replying to the invoking message fits the current contract; replying to the acknowledgement requires locating a message whose ID NTBS does not retain.
- [ ] Investigate provider requests for user input: NTBS forwards settled outcomes, so a turn waiting for input may remain active until timeout. Decide how to handle this without relying on interactive platform controls.
