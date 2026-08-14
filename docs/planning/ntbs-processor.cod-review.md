# NTBS processor review

Scope: the six files currently under `apps/server/src/ntbs`, their direct code references, and the orchestration/persistence behavior on which the processor relies. I did not use the other planning documents as input.

The implementation has a sound core idea: one opaque external-request locator, one fresh T3 thread, an exact user-message ID for finding the corresponding turn, and a small two-state adapter record. The main remaining refinements are to make ownership singular and durability explicit. At present there are no production imports, adapter implementations, or runtime wiring outside `apps/server/src/ntbs`; only the NTBS tests reference these exports. That is fine for a branch still defining the component, but the current code is inert until an adapter and processor lifecycle are wired.

## 1. Simplifications, naming, and contracts

### S1. Use one completion driver instead of polling and events

The same turn is currently owned by two mechanisms:

- `monitorT3Turn` polls the turn projection, detects terminal state, and then only returns ([processor.ts](../../apps/server/src/ntbs/processor.ts#L738)).
- `processT3Event` listens for `thread.session-set`, queries the same turn projection, and posts the result ([processor.ts](../../apps/server/src/ntbs/processor.ts#L455)).
- `responseLocks`, `messageStatus`, and the recovery choreography exist largely to keep those two paths from producing competing outcomes ([processor.ts](../../apps/server/src/ntbs/processor.ts#L223)).

The smallest design is to let the monitor reconcile every observation: when it sees a terminal turn, resolve and post that outcome; when it reaches the timeout policy, interrupt and post the timeout. Startup recovery only needs to start a monitor for each pending record. This would remove `processT3Event`, `consumeT3Events`, the hot-stream dependency, and most or all of `responseLocks`. Final replies would be delayed by at most the polling interval, currently 15 seconds.

If near-immediate replies are a hard requirement, choose the opposite ownership model: make the event consumer the sole terminal-outcome driver and keep a timer only for timeouts. The important simplification is not which one wins; it is that terminal response delivery has one owner.

### S2. Replace generic storage operations with explicit state transitions

`NTBSAdapter.save` can write either lifecycle variant with no transition or uniqueness semantics. The processor separately calls `findByRequest`, creates resources, and later calls `save`. This is a broad API for a narrow state machine and leaves the important guarantees implicit.

A plainer repository contract would expose intent rather than arbitrary persistence:

- `claimRequest(request)` atomically inserts the external request and reports whether this caller claimed it;
- `attachThread(requestUri, threadId, userMessageId)` records the created T3 resources;
- `findByThreadId(threadId)` returns an option/null rather than a second absence convention (`ThreadNotFound`);
- `listPendingResponses()` replaces the effect-valued `loadThreadsAwaitingResponse` name;
- `markResponded(threadId, responseMessageId)` is the only terminal transition.

This adds a small durable `claimed`/`provisioning` state, but removes `inFlightRequests` as a correctness mechanism, prevents backwards writes such as `ResponsePosted -> ThreadCreated`, and makes adapter conformance testable. The existing Jira delivery store already uses this shape: it claims a delivery before thread/worktree side effects.

The outbound half should likewise be one adapter operation, for example `postResponseOnce(record, response)`, with a documented stable platform marker or idempotency key. The current `findMatchingResponseMessage` followed by `postResponse` makes the processor understand an adapter-specific recovery protocol, yet still cannot make the pair atomic.

### S3. Remove surface and data that carry no behavior

These cuts are mechanical and do not change the design:

- The exact-turn lookup and its “exactly one” error are duplicated in `resolveT3Outcome` and `loadMessageStatus` ([processor.ts](../../apps/server/src/ntbs/processor.ts#L353), [processor.ts](../../apps/server/src/ntbs/processor.ts#L646)). Extract one `loadRequestTurn(threadId, userMessageId)` helper.
- `makeNTBSProcessorTag` has no consumer except the test harness. The factory already returns the service value, so the extra tag factory can wait until production wiring demonstrates a need. `makeNTBSAdapterTag` remains useful if several adapter-specific processor layers are actually constructed.

`getTurnStats` should stay conservative for now. Some of its fields look correlated, but removing activity count, last activity ID, assistant length, or update time without first checking provider projection behavior would weaken stall detection for little benefit.

### S4. Use record-oriented, plain names

The current types mix events, T3 lifecycle terms, and stored adapter state. They are records rather than domain events, and the processor assumes exactly one external request per fresh T3 thread even though “latest lifecycle state associated with a T3 thread” suggests otherwise.

| Current               | Plainer option                                                                    | Reason                                                                                  |
| --------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `NTBSLifecycle`       | `NTBSRequestRecord`                                                               | It is the adapter's current stored record, not a lifecycle process.                     |
| `ThreadEvent`         | `ThreadRequestRecord` or no standalone base alias                                 | Nothing emits this value as an event.                                                   |
| `ThreadCreated`       | `PendingResponse`                                                                 | The processor primarily cares that this record still needs a response.                  |
| `ResponsePosted`      | `RespondedRequest`                                                                | Names the terminal request state.                                                       |
| `t3Data`              | `thread`                                                                          | `record.thread.threadId` and `record.thread.userMessageId` state the contents directly. |
| `T3Context`           | `ThreadTarget`                                                                    | It is only the project and base ref used to create a thread.                            |
| `snapshot`            | `prompt` or `capturedText`                                                        | The value is sent verbatim as the first user message; “snapshot” does not say of what.  |
| `postAcknowledgement` | `acknowledge`                                                                     | The operation is best-effort and its result is unused.                                  |
| `subscribeToT3Events` | `run` (if it remains long-lived) or `recoverPending` (if polling owns completion) | The current operation also performs recovery and never returns.                         |

The recent removal of generic `PlatformData` is a good simplification and should not be reversed. Keeping one opaque, adapter-owned URI is easier to persist and recover. `sourceUri` could become `requestUri` to emphasize both identity and addressability, but that rename is optional; the more important change is to make it a validated, non-empty value.

### S5. Make the input contract executable

`NTBSInput` is a plain TypeScript type whose strongest requirements exist only in comments. In particular, `sourceUri` may be empty, `snapshot` may be blank or exceed 120,000 characters, and the attachment array may exceed the provider limit of eight. The orchestration turn-start command accepts an unrestricted string/array; the tighter provider validation happens later, after a worktree, thread, and lifecycle record already exist.

Define an Effect schema for the inbound boundary and reuse `PROVIDER_SEND_TURN_MAX_INPUT_CHARS`, `PROVIDER_SEND_TURN_MAX_ATTACHMENTS`, and `ChatAttachment`. Decode it before claiming or creating resources. This is both less prose to keep synchronized and a clearer contract for every future adapter.

### S6. Consolidate the transitional test suite

The directory currently carries two harnesses and two processor test files:

- `processor.test.ts` contains one “happy case” that only calls `process`; it has no assertions despite the preceding checklist ([processor.test.ts](../../apps/server/src/ntbs/processor.test.ts#L70), [processor.test.ts](../../apps/server/src/ntbs/processor.test.ts#L153)).
- `processor2.test.ts` is the more coherent layer harness and should become the sole `processor.test.ts`.
- Most of `test-helpers.ts` after `createAdapterRequest` is an unfinished second copy of the same harness and is not exported or used ([test-helpers.ts](../../apps/server/src/ntbs/test-helpers.ts#L75)).
- `createGitLayerMock` returns `input.refName` as the created worktree branch rather than `input.newRefName`, so a future command assertion would observe the base commit as the thread branch ([test-helpers.ts](../../apps/server/src/ntbs/test-helpers.ts#L34)).

Delete the no-assertion test and unused helper harness, rename `processor2.test.ts`, and grow that one harness around state transitions. The two focused test files currently pass (four tests total), but that result says little about the end-to-end lifecycle because only three tests make assertions and none completes a real request-to-response path.

## 2. Bugs, edge cases, and race conditions

### B1. Blocking before integration: no production code constructs or runs NTBS

No code outside `apps/server/src/ntbs` imports `makeNTBSProcessor`, `makeNTBSAdapterTag`, `NTBSProcessor`, or `subscribeToT3Events`. There is also no production adapter implementation. Consequently neither request processing nor startup recovery can currently execute. Treat this as integration status rather than an algorithm bug, but it is the first readiness item before assessing runtime behavior.

### B2. High: inbound deduplication is a check-then-act race

`inFlightRequests` protects only one in-memory processor instance. After that local check, `findByRequest` and resource creation are separate effects ([processor.ts](../../apps/server/src/ntbs/processor.ts#L996)). Two server processes, two processor instances, or an overlapping restart can both observe no record and both create a worktree/thread for the same `sourceUri`. The adapter contract recommends a natural unique key but does not require an atomic insert or define conflict behavior.

Use the atomic `claimRequest` transition described in S2 and enforce a unique key in adapter storage. The in-memory set may remain as a cheap duplicate suppressor, but it must not be the correctness boundary.

### B3. High: the durable record is written after irreversible resources are created

`createT3Thread` creates a worktree, dispatches `thread.create`, and runs setup before `ThreadCreated` is saved ([processor.ts](../../apps/server/src/ntbs/processor.ts#L790), [processor.ts](../../apps/server/src/ntbs/processor.ts#L1024)). A process exit after `thread.create` commits, a process exit during setup, or an adapter `save` failure leaves a real T3 thread/worktree with no request record. The next delivery sees no record and creates another one. Cleanup only covers failure of `thread.create` itself; it cannot cover a successful dispatch followed by process loss.

Claim and persist the request before provisioning. Record the generated thread/message IDs as soon as they are chosen, then make provisioning/recovery resume from that record. Deterministic IDs derived from the claim would be another option, but are not necessary if the state transition is durable.

### B4. High: a saved request can become dormant after turn-start failure

The processor saves `ThreadCreated` and then dispatches `thread.turn.start` ([processor.ts](../../apps/server/src/ntbs/processor.ts#L1039)). If turn start fails or the processing fiber is interrupted after the save, the record correctly remains pending. However, a redelivery finds any existing lifecycle state and immediately returns ([processor.ts](../../apps/server/src/ntbs/processor.ts#L1017)). `recoverThread` can start a missing turn, but it runs only during `subscribeToT3Events` startup, not on redelivery.

Make `process` mean “ensure this request is processing”: when `findByRequest` returns a pending record, call the same idempotent reconciliation used by startup recovery. Only a responded record should be an immediate no-op. This also collapses the split between normal processing and recovery.

### B5. High: response delivery has both a retry gap and a cross-process duplicate race

When `postResponse` or `findMatchingResponseMessage` fails, the event consumer logs the failure and continues ([processor.ts](../../apps/server/src/ntbs/processor.ts#L1079)). The monitor independently sees that the turn is terminal and exits ([processor.ts](../../apps/server/src/ntbs/processor.ts#L756)). With no later `thread.session-set` event, nothing retries until the whole processor restarts.

Conversely, two processor instances can both run `findMatchingResponseMessage`, both receive `null`, and both post before either saves `ResponsePosted`. The user-message semaphore is process-local and does not prevent this. The existing recovery check helps only after one response is visible; it is not an atomic exactly-once guarantee. Its contract also does not say how an adapter distinguishes a final response from an acknowledgement when both relate to the same source URI.

Use a durable response-delivery claim/outbox plus a stable platform marker, or make `postResponseOnce` an explicitly idempotent adapter primitive. Retry pending delivery on a bounded schedule in the running process; startup recovery should be the fallback, not the normal retry mechanism.

### B6. High: timeout can claim work stopped when it is still running

The comments correctly state that unchanged projected stats do not prove a stall ([processor.ts](../../apps/server/src/ntbs/processor.ts#L141)), but the implementation treats 12 unchanged 15-second polls—about three minutes—as a stall and interrupts the turn ([processor.ts](../../apps/server/src/ntbs/processor.ts#L734)). A coding turn can legitimately spend that long in provider work, a subprocess, or buffered output with no new projected activity.

More importantly, interrupt failure is caught and ignored, after which a timeout response is posted anyway ([processor.ts](../../apps/server/src/ntbs/processor.ts#L534)). Even a successful dispatch only proves that the interrupt command was accepted, not that the provider stopped. The full-access agent may therefore continue modifying the worktree after the external platform is told that T3 “stopped this request.”

Use a configurable elapsed-time SLA and treat observed progress only as a deadline extension, not proof that a short silence is a stall. After interrupt, wait for provider/session confirmation that the turn is no longer running before claiming it stopped. The turn projection alone is insufficient because `thread.turn-interrupt-requested` marks it interrupted when the request is recorded, before provider shutdown is confirmed. If confirmation cannot be obtained, use honest text such as “The response timed out; the T3 thread may still be running” and link or identify the thread rather than asserting cancellation.

### B7. Medium: detached monitors have no processor-owned lifetime

Both normal processing and recovery start monitors with `Effect.forkDetach` ([processor.ts](../../apps/server/src/ntbs/processor.ts#L971), [processor.ts](../../apps/server/src/ntbs/processor.ts#L1050)). Interrupting the scoped `subscribeToT3Events` effect stops the event subscription but not those monitors. Rebuilding the layer can leave old monitors using the same adapter while new recovery monitors start, and tests/runtime shutdown cannot reliably await their completion.

Fork monitors in a processor-owned scope keyed by user message ID, and interrupt that scope when the processor stops. This also provides a direct place to prevent duplicate monitors without a second free-floating map.

### B8. Medium: event processing is serial and includes remote adapter I/O

`Stream.runForEach` processes domain events one at a time, and `processT3Event` may perform adapter lookup, response search, response posting, and persistence before the next event is consumed ([processor.ts](../../apps/server/src/ntbs/processor.ts#L1079)). One slow or hung platform call therefore blocks outcomes for every other NTBS thread and lets the unbounded event PubSub backlog grow.

Removing the duplicate event path as in S1 eliminates this issue. If the event path stays, route relevant events to per-request fibers with bounded concurrency; keep the per-request serialization at the durable response transition.

### B9. Medium: unique requests have no resource bound

The API explicitly accepts unlimited concurrent distinct requests ([processor.ts](../../apps/server/src/ntbs/processor.ts#L75)). Each can fetch `origin`, create a worktree, run setup, start a full-access provider turn, and retain a monitor. A webhook replay or burst of legitimate messages can exhaust disk, git subprocesses, or provider capacity even though duplicate URIs are suppressed.

Put a configurable bound around accepted active requests, ideally at the durable claim/queue boundary so restarts do not discard queued work. At minimum, bound provisioning per project; concurrent `git fetch` and worktree setup for the same repository provide little benefit.

### B10. Medium: invalid input fails after side effects instead of at admission

Because the comment-only input invariants are not decoded, an empty URI can collapse unrelated requests onto one dedup key, and over-limit text/attachments can be accepted through orchestration only to fail at the provider boundary after resources and a pending record exist. Validate before the durable claim as described in S5, and return a stable rejected outcome rather than relying on a later provider error.

### B11. Low: an exact-turn error can use another turn's error text

The processor carefully selects the turn by the recorded user-message ID, but for an errored turn it reads `thread.session.lastError`, which is thread-wide current session state ([processor.ts](../../apps/server/src/ntbs/processor.ts#L399)). If the thread later receives another turn, that message may describe the later session rather than the NTBS turn. Until errors are stored per turn, prefer the generic failure text over potentially incorrect detail, or only use `lastError` when the selected turn is also the current/latest turn.

### B12. Confidence gap: critical transitions are untested

The current tests do not cover a successful create/start/terminal-response lifecycle, missing-turn recovery, a response found remotely after local-save failure, concurrent completion versus timeout, duplicate concurrent deliveries, retry after turn-start failure, timeout interruption, or monitor cleanup. These are exactly the paths where the implementation carries custom locks and recovery logic. After consolidating the harness, cover those transitions with controllable deferred adapter calls and a test clock; that will also make it safe to remove the redundant ownership machinery.

I specifically did not flag a projection/publication race: the orchestration engine applies the projection in the same transaction before publishing each event to `streamDomainEvents`. I also did not treat best-effort setup-script failure or the documented temporary-branch leak as new NTBS bugs; both match existing bridge behavior and are explicit choices in the current code.
