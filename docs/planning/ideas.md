# NTBS ideas

## Keep the shared lifecycle small

There is a tradeoff between recovering every possible interruption and keeping the first implementation simple. A saved `RequestAccepted` state could recover the rare case where the server receives a request but stops before creating its T3 thread. Doing that safely would also require planned thread IDs, startup searches, retries, and duplicate handling.

For now, the shared lifecycle should begin with `ThreadCreated`. The processor should save it as soon as the basic T3 thread exists, before slower preparation begins. A request can be lost if the server stops before that point, but the missing acknowledgement makes the failure visible and the user can send the request again.

A stronger recovery system can be added later if real usage requires it. Each adapter could inspect recent messages on its platform, find requests that have no corresponding T3 thread, and submit them again. This belongs to the adapter because Jira, GitHub, Discord, and Teams provide different ways to read their recent messages.

## Remove acknowledgement from the shared lifecycle

The acknowledgement is platform feedback, such as a "working on it" message. It should not be a required stage in the shared NTBS lifecycle because failing to post it, or failing to save its message ID, must not prevent the processor from representing and posting the final response.

Remove `ThreadCreatedAcknowledgement` from the lifecycle and remove `acknowledgementMessageId` from `ResponseAvailable` and `ResponsePosted`. The adapter may still post an acknowledgement and retain its identifier in its own platform-specific storage when needed. When posting the final response, the adapter can reply to the acknowledgement or fall back to the original source message according to the platform's capabilities.

The shared sequence becomes:

`Create the T3 thread → record ThreadCreated → start the work and attempt the acknowledgement independently`

The processor does not use acknowledgement success as a condition for continuing. Posting may happen alongside the start of T3 work, and an adapter may retry a failed acknowledgement, but the final answer always remains tied to the original response destination. If a platform benefits from replying to the acknowledgement, its adapter can use the identifier stored in its own data without adding that dependency to the shared lifecycle.

## Remove fork-specific provenance after the NTBS migration

Keep `SourceChannel`, `SourceRef`, `sourceHint`, `originSource`, and related fork-specific provenance out of the NTBS design. Adapters already retain the platform data needed to connect external messages with T3 work.

Once every external platform has moved to NTBS, remove these fields and the old integration logic that depends on them.

## Keep remote adapters possible

The first NTBS adapters can run inside the T3 server, but some platform integrations may remain separate programs. The current Discord bot is one example.

When a remote adapter is implemented, either move its platform operations into the server or expose the processor and adapter operations through a network API. The shared lifecycle and storage design should not require every adapter to share the T3 server process. Choose the transport when the first remote adapter is ported.

## Decide thread archival after testing

Keep NTBS-created T3 threads after their responses are posted for now. Once the workflow has been tested in practice, decide whether completed threads should be archived automatically and under which conditions.

## Add worktree cleanup to the Jira bridge

The Jira auto-create flow (`JiraIssueBridge.ts`) creates a worktree before dispatching
`thread.create` but has no compensation: a failed dispatch orphans the branch and worktree. The
NTBS processor fixed this with `Effect.onError` → forced `removeWorktree` (cleanup errors logged,
original cause re-raised). Rather than patching the bridge separately, extract the shared
`provisionThreadWorktree` helper proposed in `create-thread.adversarial-review.md` and let both
flows use it — the Jira bridge is expected to collapse onto NTBS eventually anyway.

## Delete the temporary branch when thread provisioning fails

When `thread.create` fails after `createWorktree`, the NTBS processor removes the worktree but
retains the `t3/wt-…` branch (documented in `processor.ts` as an accepted leak). Everywhere else,
branch retention is deliberate — `WorktreeLifecycle.cleanupThreadWorktree` keeps the branch so
`restoreThreadWorktree` can recreate the worktree on unarchive — but a failed provision has no
thread and nothing restorable, so retention buys nothing there.

If the ref noise ever matters, the shape is:

- Add `deleteTemporaryWorktreeBranch({ cwd, refName })` to `GitWorkflowService`, hard-guarded with
  `isTemporaryWorktreeBranch` so it structurally cannot delete a real branch. Plumbing precedent:
  checkpoint refs are deleted via `update-ref -d` in `GitVcsDriver.ts`, which also skips the
  checked-out/merged safety checks.
- In the processor's failure cleanup: `removeWorktree({ force: true })` first, then the branch
  delete (git refuses to delete a branch still checked out in a worktree), each step best-effort
  with its own log warning.
- Comment on the service op why this exception to branch retention exists, so it is not
  "harmonized" with `cleanupThreadWorktree`'s keep-the-branch behavior.

## Use Deferred for asynchronous test synchronization

Effect's `Deferred` is useful as a one-shot, promise-like latch when a test needs to wait for an
asynchronous operation to reach a specific point. The code under test completes it, while the test
awaits it deterministically, avoiding arbitrary sleeps, flaky timing assumptions, and unnecessary
polling. Use it to coordinate milestones such as a subscriber consuming an event; direct
`processor.process` tests generally do not need it.
