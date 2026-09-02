# Problem

In the current (9984c1aac36fa6035ac84d7646a5e46a93c6ea5e) implementation there's a small but non trivial issue.

**What happens**: When a request comes in, the processor first runs `planCoordinates` to find out where the work should happen: it resolves the project, fetches `origin`, pins the selected branch to its remote-tracking commit, and mints the thread, message and worktree-branch identifiers. If that fails for a permanent reason (the branch does not exist on `origin`, the project is missing, there is no `origin` remote), it's classed as `FatalError`, an error that we cannot recover from. The processor turns that into an `NTBSProcessorError` and returns it to the caller.

The problem is that nothing is written to the exchange repository: we don't know this has ever happened, and we don't inform the original user back of this fatal error as the whole delivery machine (post a reply back) only works on _exchanges that are in storage_ and those always have the `WorkCoordinates`. In order to create a `ReplyPending` we need the full `ExchangeBase` and `ExchangeBase` includes the very coordinates we just failed to resolve.

So in essence we've got a hole in our business logic that has negative implications on the user experience: failing to create `WorkCoordinates` means the request is never answered and the user will never know why. It also costs us work: every redelivery of the same request runs `planCoordinates` again, `git fetch` included, with the same result.

The `T3Gateway` port comment claims the opposite: that a `FatalError` from `planCoordinates` is converted by the processor into a reply-pending failure. That is the intent, and the code cannot deliver it.

# Possible solutions

## Caller side

One simple fix could be to have `processor.process(request)` properly surface this problem to the caller and have the caller notify the end user. Today both a rejection and a transient failure come back as the same `NTBSProcessorError`, so this requires splitting it: the caller must know whether to post a rejection or to retry later.

This would keep most of our current code and flow intact, but at some costs:

1. lack of audit. As the request is never recorded we never get to know it failed.
2. there's now a reply path outside the exchange lifecycle entirely. It gets none of the existence check, `Undeliverable` handling, or sweeper retries that `ReplyPending` delivery has.
3. no redelivery dedup. If the same request arrives again after the rejection was posted, it is posted again. Nothing was stored, so the `sourceUri` lock and lookup never see these requests.

## RequestRejected

Another possible solution was to add another state `RequestRejected` without `t3` or with `t3` null.

This was rejected because it would imply creating a new state for the sole purpose of sending a reply with a different input. This would also cost real code, every state that handles replies new machinery.

## Accepted state

In order to solve the pains from the two other solutions we adopt a third one that:

- keeps the orchestration responsibility all in `processor`
- makes the states more transparent

The first state, `RequestAccepted`, holds only the request and the target. No T3 data. It records that we received the request; everything after it can fail and becomes a failure reply like any other.

Reply states drop T3 data too. Delivery needs only `sourceUri` and the reply. What produced the reply lives inside the reply: an answer carries the thread, user message and turn ids; a failure carries whatever existed when it happened, which for a planning rejection is nothing from T3.

Only `WorkPlanned` and `ThreadCreated` keep `t3`: the states in which T3 work is happening. `ExchangeBase` becomes request plus target and loses `t3`.

`process` looks up the exchange, persists `RequestAccepted`, then advances it. It fails only when the repository fails. Anything that fails after the save is logged and left to `run`. Planning becomes the `request-accepted` step of `advanceExchange`: `planCoordinates` succeeds into `WorkPlanned`, fails permanently into `ReplyPending`, fails transiently and stays put for the sweeper.

`Reply` becomes a tagged union. Each variant declares its own context: an answer carries thread, user message and turn ids; a failure carries a typed cause with the ids that existed when it happened; a cancellation carries thread, user message and turn ids. The cause is built where the failure is understood and is JSON-safe by construction. `cause: unknown` and the processor's `createReplyFailure` go away. This closes review item M4.

The repository's `findByThreadId` and its thread-id uniqueness check only consider `WorkPlanned` and `ThreadCreated`, the only states that have a thread id. T3 activity on a thread whose exchange already has a reply is ignored.

### Tests

Every existing test in `exchange.test.ts`, `processor.test.ts` and `ExchangeRepository.test.ts` is rechecked against the new states and reply shape. On top of that:

- [ ] Accepted, planning fatal, failure reply posted with no T3 context.
- [ ] Accepted, planning transient, unchanged, sweep retries and reaches `WorkPlanned`.
- [ ] Redelivery after acceptance does no planning.
- [ ] `process` succeeds when planning fails after the save.
