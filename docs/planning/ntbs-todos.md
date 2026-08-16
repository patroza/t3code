# Is the whole NTBS contract a state machine in disguise?

`NTBSAdapter.save` is currently a generic write: "store this state, whatever it
is." Nothing prevents an invalid transition such as `ResponsePosted ->
ThreadCreated`, and nothing in the contract requires two deliveries of the same
external request to converge on one exchange.

This shifts much of the lifecycle choreography into the processor. It repeatedly
checks adapter storage, T3 projections, process-local locks, and the external
platform to determine what has already happened and what is safe to do next.

The current implementation is therefore a multi-step process manager represented
by only two stored variants:

```text
Request received          no stored exchange state
Thread created            no stored exchange state until setup finishes
ThreadCreated saved       thread.created
Turn started              thread.created
Turn completed            thread.created
Reply posted              thread.created until the subsequent save succeeds
ResponsePosted saved      thread.response.posted
```

`ThreadCreated` consequently describes several materially different situations:

- the first turn was never started;
- the turn is pending or running;
- the turn finished but its reply has not been posted;
- the reply was posted but the processor stopped before recording it.

That ambiguity is why `recoverThread` has to query T3 for the matching turn and
branch on whether it is missing, active, or terminal. It is also why
`findMatchingResponseMessage` has to inspect the external platform before every
post attempt.

## Where the two-state model causes real problems

### There is no durable admission state

`process` calls `findByRequest`, creates the worktree and T3 thread, and only then
saves `ThreadCreated`. `inFlightRequests` suppresses concurrent delivery only
inside one processor instance. Two processes can both observe no state and create
duplicate work, while a process exit after thread creation but before the save
leaves an orphaned thread that redelivery cannot discover.

A pre-thread state can close this gap only if it is created through an atomic
insert-if-absent operation keyed by `sourceUri`. A generic read followed by a
generic save is not sufficient.

### `ThreadCreated` does not identify the next recovery action

The processor saves `ThreadCreated` before dispatching `thread.turn.start`. If
turn start fails, a later delivery finds an existing state and returns without
reconciling it. Startup recovery does reconcile the same state, but restarting
the server should not be the ordinary retry mechanism.

The same state remains stored after the turn starts and after it finishes. The
processor can recover only by consulting T3 and inferring which transition was
missed.

### Reply delivery has an unavoidable cross-system gap

The processor posts a reply to the external platform and then saves
`ResponsePosted`. Those operations cannot share a transaction. If posting
succeeds and the save fails, adapter storage still says `ThreadCreated` even
though the user has already received the reply.

The current platform lookup is a useful reconciliation mechanism, but the reply
payload is recomputed from T3 on every attempt. That payload can drift between
attempts, making content-based matching an unreliable idempotency boundary.

## Argument for a richer state machine

A richer durable model could:

- claim a source request atomically before creating resources;
- give every incomplete state one explicit recovery action;
- make ordinary redelivery, startup recovery, and live T3 events call the same
  reconciliation path;
- persist the exact terminal response before attempting external delivery;
- make legal transitions explicit and prevent backwards writes;
- support atomic compare-and-set transitions across multiple processor
  instances;
- make adapter conformance and crash-window behavior testable.

The adapter contract would express operations such as `claim` and an atomic
expected-state transition instead of accepting any `ExchangeState` through
`save`.

## Argument against mirroring every observed step

A literal state sequence might look like this:

```text
RequestReceived
-> ThreadCreated
-> TurnStarted
-> TurnCompleted
-> ReplySent
```

This identifies the hidden workflow, but it is not quite the right durable
model. `TurnStarted` and `TurnCompleted` are already durable facts owned by T3.
Copying them into adapter storage creates two sources of truth that cannot be
updated atomically.

For example, persisting `TurnStarted` before dispatch can claim that a turn
started when it did not. Dispatching first and persisting afterward leaves a
window in which the turn exists but the exchange still says `ThreadCreated`.
Adding the state moves the ambiguity without eliminating it. The same problem
applies to `TurnCompleted` and `ReplySent`.

Some deduplication also remains inherent regardless of the number of states:

- source platforms deliver events at least once, so inbound requests require a
  durable idempotency key;
- adapter storage and T3 cannot share a transaction, so their state must be
  reconciled after interruption;
- adapter storage and an external posting API cannot share a transaction, so
  reply delivery requires an idempotency key or a platform reconciliation step;
- startup recovery and live events can race, so state transitions need atomicity
  or serialization even when their states are more precise.

Acknowledgement delivery is also intentionally independent of final-response
delivery. It should not become a required step in one linear exchange state
machine merely to make the sequence appear complete.

## Refined proposal: persist coordinator states

The shared state should describe NTBS-owned handoffs and recovery decisions,
rather than duplicate T3's internal thread and turn state:

```text
RequestClaimed
-> ThreadCreated
-> AwaitingOutcome
-> ReplyPending
-> ReplyPosted
```

### `RequestClaimed`

The adapter has atomically claimed `sourceUri` for processing. This state must
retain everything needed to recover thread provisioning from a cold start,
including the request, thread target, and stable planned identifiers. "Claimed"
is more precise than "received": the processor receives only requests that have
already passed platform trigger and actor checks, and duplicate receipt must not
imply ownership by a second processor.

### `ThreadCreated`

The planned T3 thread exists and is correlated with the external request. A
reconciler in `RequestClaimed` must be able to determine whether creation already
succeeded before retrying it, which requires assigning stable identifiers before
the side effect.

### `AwaitingOutcome`

The processor is responsible for ensuring that the planned turn is requested and
for observing its terminal state. T3 remains the source of truth for whether the
turn is missing, pending, running, completed, failed, or cancelled. This avoids a
stale adapter-owned copy of `TurnStarted` while still giving recovery a clear
action.

### `ReplyPending`

T3 has reached a terminal outcome and the exact `NTBSResponse` payload has been
stored together with a stable delivery key. Recovery posts this stored payload
rather than recomputing it. Persisting reply intent before posting narrows
platform inspection to the genuine post-succeeded/save-failed window.

### `ReplyPosted`

The external platform has accepted the final reply and its message identifier is
stored. This is the terminal state. "Posted" is preferable to "sent" because
"sent" can describe an attempt that produced no durable platform message.

Each state then has one reconciliation rule:

```text
RequestClaimed  ensure the planned thread exists
ThreadCreated   ensure the planned turn is requested
AwaitingOutcome inspect T3 and materialize a terminal response
ReplyPending    post the stored response idempotently
ReplyPosted     do nothing
```

`process`, startup recovery, and relevant T3 events should all load the exchange
and invoke this same reconciler. Their different triggers should not produce
different lifecycle semantics.

## Open design questions

- Which thread, message, worktree, and command identifiers must be allocated and
  stored at claim time to make provisioning safely repeatable?
- Does `RequestClaimed` also retain `projectId` and `baseRef`, which are currently
  passed separately and discarded after thread creation?
- Should transitions use compare-and-set on the expected state, a monotonically
  increasing version, or both?
- Can every platform provide an idempotency key for reply creation, or must some
  adapters search for an already-posted reply during recovery?
- Is `ReplyPending` sufficient as an outbox, or should reply delivery be a
  separate durable entity with its own retry metadata?
- How should permanently failed provisioning become a terminal response rather
  than an exchange that remains claimed forever?
- Which acknowledgement metadata belongs in adapter-specific storage without
  becoming a blocking shared lifecycle state?
- Should one processor instance lease a claimed exchange while reconciling it,
  or are atomic transitions and idempotent effects sufficient?

The central design requirement is not merely to add more union members. The
state machine must claim requests atomically, store intent before non-atomic
effects, keep T3 authoritative for T3-owned facts, and make every incomplete
state safely reconcilable.
