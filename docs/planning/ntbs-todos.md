# NTBS exchange lifecycle

**Status:** decided 2026-08-16 · supersedes the two-state `ExchangeState`

The old model stored only `ThreadCreated | ResponsePosted` through a generic `save`, so the processor had to re-derive "what already happened" from adapter storage, T3 projections, process-local locks, and the external platform on every step. The settled design replaces it with a claimed, forward-only exchange machine with one reconciler.

## States

```text
RequestClaimed -> ThreadCreated -> ReplyPending -> ReplyPosted
                                        \
                                         -> Undeliverable
```

- **`RequestClaimed`** — the platform inbound code admitted the request (trigger and actor checks passed) and the processor recorded the claim; from here the processor alone drives the exchange to a terminal state, and redeliveries change nothing. Carries the full request (`sourceUri`, snapshot, attachments), the T3 context (`projectId`, `baseRef`), and pre-minted planned IDs (`threadId`, `userMessageId`, branch name) so a cold start can redo provisioning without the original webhook and detect an already-created thread instead of duplicating it.
- **`ThreadCreated`** — the planned thread exists; the IDs are confirmed facts. No turn state is stored: turn existence and progress are T3-owned.
- **`ReplyPending`** — T3 reached a terminal outcome; the exact reply payload is stored verbatim so every posting attempt sends the same content.
- **`ReplyPosted`** — terminal. The platform accepted the reply; its message ID is stored.
- **`Undeliverable`** — terminal, entered only from `ReplyPending`: a
  finished reply exists but posting was given up after bounded attempts.
  Stores the undelivered payload and the cause. The tombstone keeps dedup
  intact and stops the sweep from retrying forever.

## Invariants

- One exchange per `sourceUri`, for its whole life. Duplicate deliveries join
  it, never create another; they are pure dedup and trigger no repair.
- Forward-only lifecycle: moving backwards is an error, not a write. Failure
  may jump ahead to `ReplyPending`.
- States track delivery, not outcome quality. Answer, failure, or
  cancellation is data in the reply payload, never a state. Every exchange
  ends in `ReplyPosted` or `Undeliverable`.
- T3 stays authoritative for T3-owned facts — no `TurnStarted` or
  `AwaitingOutcome` copies in adapter storage.
- Turn-start idempotency rests on `getTurn` being read-your-writes at
  reconcile time; provisioning recovery must treat worktree creation as
  reentrant (the branch may already exist from a pre-crash attempt).

## Recovery

The processor owns recovery. One reconciler, three triggers: startup,
relevant T3 events, and a periodic sweep over incomplete exchanges. The sweep
is the guarantee; live events are only the fast path. Platform redelivery is
not a retry mechanism.

## Pure decider

The branching rules are one pure function,
`stored state + retrieved observation (+ attempts) -> next action`, with
companion transition constructors that turn an action's _result_ into the
next stored state. Decision and transition stay separate so no state ever
records an effect that has not happened. Each state names the single
observation to fetch first:

```text
RequestClaimed  planned thread exists?                Provision | AdvanceToThreadCreated
ThreadCreated   turn missing | active | terminal(r)   StartTurn | Wait | StoreReply(r)
ReplyPending    my reply on platform? no | yes(id)    Post | RecordPosted(id) | GiveUp(cause)
ReplyPosted / Undeliverable                           Done
```

`StartTurn` persists no exchange transition — turn existence is T3's fact.
The bounded-retry give-up rule lives inside the decider so it is testable.
Orchestration proper — scheduling the triggers, fetching observations,
executing effects, the in-process outcome lock, persisting transitions —
stays in the processor.

## Reply delivery

Identity and content are separate:

- **Identity**: the adapter must answer with certainty whether its reply for
  this exact exchange exists on the platform — structural attribution
  (Discord reply referencing the trigger message, Jira comment linkage) or an
  embedded exchange UUID as last resort. Never content matching; identical
  texts legitimately recur.
- **Content**: the verbatim payload stored in `ReplyPending`, so retries post
  the same thing.

Delivery is: check existence -> post if absent -> record posted.

## Failure path

Any permanent failure (provisioning, turn, lost thread) becomes a
failure-typed reply through the normal delivery pipe after bounded attempts;
delivering it ends the exchange in `ReplyPosted` — a completed job from the
processor's view. Only when posting itself is given up does the exchange end
`Undeliverable`.

## Acknowledgement

The processor never learns whether the ack succeeded; no exchange state waits
on it. The adapter records the ack message ID locally and may deliver the
final reply by editing that ack instead of posting fresh — a rendering choice
it owns. An adapter doing so must count the edited ack as the existing reply
in its certainty check. A crash before the ack means it is simply never
posted; the final reply is unaffected.

## Adapter contract (shape, not API)

Operations the contract must express: claim (duplicates join the existing
exchange), persist-transition (forward-only), load-incomplete for the sweep,
the reply-existence certainty check, post-reply, and fire-and-forget ack.
Dependencies point at the platform client and storage only — never at the
processor. No leases, no multi-process machinery: the real deployment is one
server process. How an adapter enforces the invariants is implementation,
decided during the build.

## Build order

Model → contract → orchestration; each phase leaves the previous one settled.

1. **Exchange (the model).** The five states with their decided contents. Transition constructors as the only way to build each state from its predecessor plus an effect result. The observation and action vocabularies, and the pure decider with its give-up rule. Pure table tests for decider and transitions — no Effect scaffolding.

2. **Adapter (the contract).** Reshape the interface around the model per "Adapter contract" above. Update the in-memory test adapter.

3. **Processor (orchestration).** Collapse `process` / `recoverThread` / `processT3Event` into one loop: load → fetch the state's observation → decide → execute → persist. Admission becomes claim-then-reconcile. Add the periodic sweep as the third trigger beside startup and T3 events. Keep the outcome lock; review whether `inFlightRequests` still earns its place. Crash-window tests drive the real loop against the in-memory adapter.

4. **Jira port** (ntbs-plan step 3) as the first real adapter on the settled contract, replacing the legacy bridge path.
