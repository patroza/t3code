# NTBS ideas

## Keep the shared lifecycle small

There is a tradeoff between recovering every possible interruption and keeping the first implementation simple. A saved `RequestAccepted` state could recover the rare case where the server receives a request but stops before creating its T3 thread. Doing that safely would also require planned thread IDs, startup searches, retries, and duplicate handling.

For now, the shared lifecycle should begin with `ThreadCreated`. The processor should save it as soon as the basic T3 thread exists, before slower preparation begins. A request can be lost if the server stops before that point, but the missing acknowledgement makes the failure visible and the user can send the request again.

A stronger recovery system can be added later if real usage requires it. Each adapter could inspect recent messages on its platform, find requests that have no corresponding T3 thread, and submit them again. This belongs to the adapter because Jira, GitHub, Discord, and Teams provide different ways to read their recent messages.

## Durable request dedup is necessary yet insufficient

The `adapter.findByRequest` check at the start of `processAdapterRequest` (`processor.ts`) cannot be
removed. It is the only durable dedup in the pipeline: `inFlightRequests` is in-memory, covers only
concurrent deliveries inside one process, and is cleared the moment a request finishes or the server
restarts. The source platforms deliver at-least-once (webhook retries, Discord gateway replays), so
without this check a late redelivery would create a second worktree, thread, and turn, and post a
second final response. Deferring the check to a uniqueness conflict in `adapter.save` would be
worse, because the conflict would surface only after the expensive thread provisioning already ran.

The check is still insufficient on its own. It is check-then-act against the adapter store, and
between `createT3Thread` and the `adapter.save` of `ThreadCreated` there is a crash window where no
record exists yet: a redelivery after a crash there passes `findByRequest` and provisions a
duplicate thread. The fix, if real usage ever needs it, is not another read but an atomic
insert-if-absent reservation keyed by `getRequestKey` before thread creation. That is the same
tradeoff already described in "Keep the shared lifecycle small": a pre-thread lifecycle state plus
recovery for stale reservations. Defer it until a production adapter observes redelivery during a
crash; the dedup behavior itself is pinned by the processor test that drops a redelivered request
with a recorded thread.

## Remove acknowledgement from the shared lifecycle

The acknowledgement is platform feedback, such as a "working on it" message. It should not be a required stage in the shared NTBS lifecycle because failing to post it, or failing to save its message ID, must not prevent the processor from representing and posting the final response.

Remove `ThreadCreatedAcknowledgement` from the lifecycle and remove `acknowledgementMessageId` from `ResponseAvailable` and `ResponsePosted`. The adapter may still post an acknowledgement and retain its identifier in its own platform-specific storage when needed. When posting the final response, the adapter can reply to the acknowledgement or fall back to the original source message according to the platform's capabilities.

The shared sequence becomes:

`Create the T3 thread → record ThreadCreated → start the work and attempt the acknowledgement independently`

The processor does not use acknowledgement success as a condition for continuing. Posting may happen alongside the start of T3 work, and an adapter may retry a failed acknowledgement, but the final answer always remains tied to the original response destination. If a platform benefits from replying to the acknowledgement, its adapter can use the identifier stored in its own data without adding that dependency to the shared lifecycle.

## Persist response intent before posting (outbox pattern)

`postResponse` in `processor.ts` posts the final response to the platform and then saves
`ResponsePosted`. Because the post targets an external platform and the save targets the local
store, no transaction can span both, and compensation (deleting the posted message when the save
fails) cannot close the hole either: the failure mode that matters is process death between post
and save, and a dead process runs no compensation. Deleting an already-read correct answer because
a local write failed is also worse UX than retrying the save, and some adapters (Jira comments,
restricted channels) may lack delete permission entirely.

Today that crash window is covered by `findMatchingResponseMessage`, which probes the platform by
response content on every post. Content is the wrong identity test: the recomputed outcome can
drift across restarts (a posted timeout resolves as a cancellation after recovery interrupts the
turn; the `error` branch depends on `session.lastError`), so the probe misses the earlier response
and a second, differently-worded final response gets posted.

The fix is to persist intent before posting:

1. Save a `thread.response.posting` state carrying the response payload (type + text).
2. Post to the platform.
3. Save `thread.response.posted` with the platform message ID.

This gives recovery precision (only records stuck in `response.posting` may have an unrecorded
post — `thread.created` records are known-unposted and need no platform search), removes the drift
bug (recovery reposts the stored text instead of recomputing the outcome), and makes a failed
step-3 save trivially retryable. The platform probe shrinks to a rarely-exercised recovery path,
and its contract should be "any final response this adapter already posted for this request"
(`findResponseMessage(state)`, no `response` parameter) rather than content matching.

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

## Start the T3 event subscription with the processor

Processors should subscribe to T3 events automatically as part of their managed startup
lifecycle, rather than exposing `subscribeToT3Events` for callers to invoke. The public processor
API should focus on business operations such as `process`; the subscription and stored-thread
recovery should start when the processor layer is provided and stop with its application scope.
Use a scoped resource or layer so the background fiber is owned, interruptible, and cannot be
accidentally started twice by callers. Tests should construct the live processor, publish an event,
and assert the observable result without manually starting the subscription.
