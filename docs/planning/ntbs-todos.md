# NTBS todos

The exchange model, ports, processor, and T3 gateway are implemented under `apps/server/src/ntbs/`. This file tracks only what is still open. Findings referenced by id are in `review-01-09.md`.

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
