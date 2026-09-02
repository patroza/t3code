# NTBS todos

The exchange model, ports, processor, and T3 gateway are implemented under `apps/server/src/ntbs/`. This file tracks only what is still open. Findings referenced by id are in `review-01-09.md`.

## Rejected requests (before a claim exists)

**Decided 2026-09-02.** `planCoordinates` can fail permanently (branch not on `origin`, project missing, no `origin` remote). There is no exchange to store that on, because `ExchangeBase` needs the coordinates that just failed. Today the user hears nothing while the platform redelivers and each redelivery re-fetches.

The adapter owns the reply for a rejected request. No exchange is ever recorded.

- [ ] Split `NTBSProcessorError` so `process` returns a typed `RequestRejected` (permanent, carries the user-facing reason) distinct from transient failures. Only the rejected variant triggers a reply; a transient failure still surfaces as a webhook error so the platform redelivers.
- [ ] The inbound adapter code renders `RequestRejected` to the platform and acks the webhook.
- [ ] Fix the port doc comment in `t3gateway.ts` ("converts that into a reply-pending failure").
- [ ] Accepted for now: a crash between posting the rejection and acking the webhook posts it twice, and rejected requests leave no NTBS trail.

Future direction: a second, adapter-owned store keyed by the platform's inbound message id (inbound id → outcome). Gives the adapter redelivery dedup and an audit trail for rejected requests without touching the exchange model. It must never mirror exchange state.

## Bound every retry (H1, M2, M3)

- [ ] Add `claimedAt`/`updatedAt` and an attempt counter to `ExchangeBase`; per-state deadlines in the decider; exponential backoff in the sweeper.
- [ ] `provisionThread`: T3 invariant rejection while the thread is absent is `FatalError`, mirroring `startTurn`.
- [ ] `getTurnStatus`: when no turn row carries our `userMessageId` but the session settled in `error`, answer `completed` with a failure reply from `session.lastError`.

## Durable readiness marker (H3, H4)

Provisioning today is worktree → `thread.create` with the final path → fire-and-forget setup script. `getThreadStatus` reports `present` from the thread shell alone, so a crash between `thread.create` and setup skips setup permanently, and a fatal cleanup leaves a thread pointing at a removed worktree.

- [ ] Create the thread with `worktreePath: null`, ensure the worktree, run setup and wait, then dispatch `thread.meta.update` with the final path.
- [ ] Add `ProjectSetupScriptRunner.runForThreadAndWait` backed by `ProcessRunner`, with a timeout and bounded diagnostic output; failure or timeout is `RetryableError`.
- [ ] `getThreadStatus` reports `present` only with a non-null `worktreePath`. Fix the test that pins the opposite.
- [ ] On `FatalError` after `thread.create`, cleanup also dispatches `thread.delete`.
- [ ] Setup is at-least-once; scripts must be idempotent.

## Other review items

- [ ] M1: `process` returns once the claim is persisted; a failing advance after the claim is logged and left to `run`.
- [ ] H5: narrow `threadActivity` to session/turn lifecycle events; `Effect.timeout` on every adapter and gateway call.
- [ ] M4: type reply `cause` as a JSON-safe schema before the SQL repository lands.
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
