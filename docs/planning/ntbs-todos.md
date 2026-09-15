# NTBS todos

The exchange model, ports, processor, and T3 gateway are implemented under `apps/server/src/ntbs/`. This file tracks only what is still open. Findings referenced by id are in `review-01-09.md`.

## Other review items

- [ ] H5: narrow `threadActivity` to session/turn lifecycle events.
- [ ] L3: worktree branch uses the full thread UUID with a non-temporary prefix so T3 does not rename it.

## Tests

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
