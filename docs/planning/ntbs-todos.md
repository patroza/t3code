# NTBS exchange lifecycle

**Status:** decided 2026-08-16 · supersedes the two-state `ExchangeState`

The old model stored only `ThreadCreated | ResponsePosted` through a generic `save`, so the processor had to re-derive "what already happened" from adapter storage, T3 projections, process-local locks, and the external platform on every step. The settled design replaces it with a claimed, forward-only exchange machine with one reconciler.

## Ports

Three ports, one per thing the exchange has to touch. Each knows only what it wraps, and none of them knows about the others.

- **Exchange repository** — the durable record of where each exchange got to. Stores, looks up by `sourceUri` or `threadId`, and lists the incomplete ones for startup recovery. Nothing in it reaches T3 or the platform.
- **Adapter** — the originating platform. Posts the acknowledgement and the reply, and answers with certainty whether its reply for this exchange is already there. The only piece that may parse a `sourceUri`.
- **T3 gateway** — T3 and the VCS lifecycle behind it. Plans the identifiers, provisions the thread and worktree, starts the turn, reports thread and turn status, and signals which threads have moved.

The processor sits above them and holds the orchestration none of them have: it reads the state, asks the relevant port what is true now, decides, executes, and records the transition. It is the only writer of exchange state, and the only place the three ports meet.

No leases and no multi-process machinery anywhere: the real deployment is one server process. How each port enforces the invariants is implementation, decided during the build.

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
- **`Undeliverable`** — terminal, entered only from `ReplyPending`: a finished reply exists but the platform definitively rejected delivery. Stores the undelivered payload and a serializable explanation. The tombstone keeps dedup intact and stops the processor from retrying forever.

## Invariants

- One exchange per `sourceUri`, for its whole life. Duplicate deliveries join it, never create another; they are pure dedup and trigger no repair.
- Forward-only lifecycle: moving backwards is an error, not a write. Failure may jump ahead to `ReplyPending`.
- States track delivery, not outcome quality. Answer, failure, or cancellation is data in the reply payload, never a state. Every exchange ends in `ReplyPosted` or `Undeliverable`.
- T3 stays authoritative for T3-owned facts — no `TurnStarted` or `AwaitingOutcome` copies in the stored exchange.
- Turn-start idempotency rests on `getTurn` being read-your-writes at reconcile time; provisioning recovery must treat worktree creation as reentrant (the branch may already exist from a pre-crash attempt).

## Recovery

An exchange can be cut in half by the server stopping: a thread was provisioned, but a turn never started, a reply was computed but not posted, etc.

The stored state say how far did the exchange go, so work can be easily resumed.

On startup the processor loads every incomplete exchange and continues it. While running, T3 events tell it when a turn has finished so the reply can be posted.

An optional, additional recovery method can be envisioned by a periodic function checking whether any non-terminal exchange hung and can be resumed. Any of the non-terminal states can strand: provisioning that keeps failing, a turn that was never started, a turn T3 still calls active but that will never finish (the agent died, hit its token limit, the provider hung), a reply whose posting keeps being rejected. None of these produce an event, so nothing wakes the exchange up.

It first requires proper invariants and heuristics to be defined — chiefly, how long a state may legitimately sit before it counts as stuck, which differs per state and is not knowable from the exchange alone.

## Pure decider

The branching rules are pure: `stored state + retrieved observation -> next action`. Decision and transition stay separate so no state records an external effect before it happens. The processor retrieves the one observation relevant to the current state and interprets the returned action:

```text
RequestClaimed  planned thread missing | present      Provision | RecordThreadCreated
ThreadCreated   turn missing | active | completed(r)  StartTurn | Wait | RecordReplyPending(r)
ReplyPending    my reply missing | posted(id)         PostReply | RecordReplyPosted(id)
ReplyPosted / Undeliverable                           Done
```

The state-specific contexts contain only plain, already-retrieved data—never adapters, repositories, clocks, `Effect`s, or query functions:

```ts
type RequestClaimedContext = { readonly thread: "missing" } | { readonly thread: "present" };

type ThreadCreatedContext =
  | { readonly turn: "missing" }
  | { readonly turn: "active" }
  | { readonly turn: "completed"; readonly reply: Reply };

type ReplyPendingContext =
  | { readonly platformReply: "missing" }
  | {
      readonly platformReply: "posted";
      readonly replySourceUri: string;
    };
```

Temporary failures do not change the exchange state, so the processor can try the same operation again later. If creating the thread or starting the turn has permanently failed, the processor creates a failure reply and moves the exchange to `ReplyPending`. If the platform permanently refuses to post that reply, the processor moves the exchange to `Undeliverable`. The processor decides whether an error is temporary or permanent when the operation fails; the decider only sees the plain result it needs.

Pure transition constructors preserve the forward-only lifecycle:

```ts
declare const toThreadCreated: (state: RequestClaimed) => ThreadCreated;

declare const toReplyPending: (state: RequestClaimed | ThreadCreated, reply: Reply) => ReplyPending;

declare const toReplyPosted: (state: ReplyPending, replySourceUri: string) => ReplyPosted;

declare const toUndeliverable: (state: ReplyPending, cause: UndeliverableCause) => Undeliverable;
```

`StartTurn` persists no exchange transition—turn existence is T3's fact. Orchestration proper—scheduling triggers, fetching observations, executing actions, classifying operational failures, applying transitions, and persisting them—stays in the processor.

## Reply delivery

Identity and content are separate:

- **Identity**: the adapter must answer with certainty whether its reply for this exact exchange exists on the platform — structural attribution (Discord reply referencing the trigger message, Jira comment linkage) or an embedded exchange UUID as last resort. Never content matching; identical texts legitimately recur.
- **Content**: the verbatim payload stored in `ReplyPending`, so retries post the same thing.

Delivery is: check existence -> post if absent -> record posted.

## Failure path

Any definitive failure while provisioning, starting a turn, or recovering a lost thread becomes a failure-typed reply through the normal delivery pipe; delivering it ends the exchange in `ReplyPosted`—a completed job from the processor's view. Transient failures leave the current state unchanged and are retried in place. Only a definitive rejection of reply delivery ends the exchange in `Undeliverable`.

## Acknowledgement

The processor never learns whether the ack succeeded; no exchange state waits on it. The adapter records the ack message ID locally and may deliver the final reply by editing that ack instead of posting fresh — a rendering choice it owns. An adapter doing so must count the edited ack as the existing reply in its certainty check. A crash before the ack means it is simply never posted; the final reply is unaffected.

## Build order

Model → contract → orchestration; each phase leaves the previous one settled.

1. **Exchange (the model).** The five states with their decided contents. Transition constructors as the only way to build each state from its predecessor plus an effect result. The observation and action vocabularies, and the pure decider. Pure table tests for decider and transitions—no Effect scaffolding.

2. **Ports (the contracts).** The exchange repository, the adapter and the T3 gateway, each shaped around the model per "Ports" above. Update the in-memory test adapter.

3. **Processor (orchestration).** Collapse `process` / `recoverThread` / `processT3Event` into `process` plus one internal reconciler; the exposed surface stays `process` and `run`. `process` claims, then provisions and starts the turn. `run` calls the reconciler — load → observe → decide → execute → persist — on startup and on T3 events. Serialize per `sourceUri`; the outcome lock and `inFlightRequests` collapse into that. Crash-window tests drive the real loop against the real in-memory repository, with the adapter and T3 gateway faked.

4. **Jira port** (ntbs-plan step 3) as the first real adapter on the settled contract, replacing the legacy bridge path.

## Remaining processor tests

The processor tests are grouped by responsibility: `process`, source serialization, `run`, and reply delivery.

Lifecycle and retry behavior:

- [x] A transient `postReply` failure leaves the exchange in `ReplyPending`; a later recovery retries and reaches `ReplyPosted`.
- [x] A transient `findPostedReply` failure leaves the exchange in `ReplyPending`; a later recovery repeats discovery before posting.
- [x] A failed acknowledgement is best-effort: processing still persists `ThreadCreated` and starts the turn.
- [x] An active turn leaves `ThreadCreated` unchanged and performs no delivery work.
- [x] A transient `provisionThread` failure leaves `RequestClaimed`; later recovery provisions the thread successfully.
- [x] A transient `getTurnStatus` failure leaves `ThreadCreated`; later activity retries and records the completed reply.
- [x] A transient `startTurn` failure leaves `ThreadCreated`; later recovery retries the start.
- [x] Extend the post-persistence failure test to prove the retained `RequestClaimed` can later be resumed by `run`.

`run` robustness:

- [x] One exchange failing during startup recovery does not prevent another exchange from advancing.
- [x] One thread-activity event failing does not stop later activity events from being processed.
- [x] Activity subscription starts before recovery: an event arriving while startup recovery is blocked is not missed.
- [x] Startup recovery racing with activity for the same exchange posts only one reply.

After these cases, stop expanding the processor suite unless its contract changes. Do not add tests for every `NTBSProcessorError.reason` string, every lifecycle tag already covered by the pure model tests, repository behavior already covered by `ExchangeRepository.test.ts`, internal lock-map deletion with no observable behavior, or every `Reply` subtype that the processor handles identically.
