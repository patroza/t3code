# NTBS processor review

**Status:** Reconciled with the monitor-free processor on 2026-08-15. Addressed findings have been removed, so numbering gaps are intentional.

**Scope:** The six files in [`apps/server/src/ntbs`](../../apps/server/src/ntbs/), their direct code references, and the orchestration/persistence behavior on which the processor relies. Other planning documents were not used as input.

The implementation has a sound core: one opaque external-request locator, one fresh T3 thread, an exact user-message ID for finding the corresponding turn, and a two-state adapter record. Completion now has one live owner—the `thread.session-set` event listener—while startup recovery only starts missing turns or reconciles outcomes that finished while the processor was down. The main remaining refinements are durability and making the small contracts say exactly what the processor assumes.

At present, no production code outside the NTBS directory constructs an adapter or processor, so the component remains inert until runtime wiring is added.

## 1. Simplifications, naming, and contracts

### S2. Replace generic storage operations with explicit state transitions

[`NTBSAdapter.save`](../../apps/server/src/ntbs/adapter.ts#L32-L36) can write either lifecycle variant without stating transition, uniqueness, or upsert semantics. The processor separately checks [`findByRequest`](../../apps/server/src/ntbs/processor.ts#L687-L695), creates resources, and saves afterward. That broad API leaves the important guarantees implicit.

A plainer repository contract would expose intent:

- `claimRequest(request)` atomically inserts the external request and reports whether this caller claimed it;
- `attachThread(requestUri, threadId, userMessageId)` records the created T3 resources;
- `findByThreadId(threadId)` returns `null` rather than introducing a second absence convention through `ThreadNotFound`;
- `listPendingResponses()` replaces `loadThreadsAwaitingResponse`;
- `markResponded(threadId, responseMessageId)` is the only terminal transition.

This introduces a small durable claimed/provisioning state, but removes `inFlightRequests` as a correctness boundary, prevents backwards writes such as `ResponsePosted -> ThreadCreated`, and makes adapter conformance testable. The existing [`JiraDeliveryStore.claim`](../../apps/server/src/jira/JiraDeliveryStore.ts#L66-L66) is a nearby example of atomic admission before side effects.

The outbound half could likewise be one adapter operation such as `postResponseOnce(record, response)`, with a documented stable platform marker or idempotency key. The current [`findMatchingResponseMessage` then `postResponse`](../../apps/server/src/ntbs/processor.ts#L325-L338) makes the processor understand an adapter recovery protocol without making that pair atomic.

### S3. Remove the processor tag factory until it has a production consumer

[`makeNTBSProcessorTag`](../../apps/server/src/ntbs/processor.ts#L96) is used only by the two test harnesses ([`processor.test.ts:45`](../../apps/server/src/ntbs/processor.test.ts#L45), [`processor2.test.ts:159`](../../apps/server/src/ntbs/processor2.test.ts#L159)). The factory already returns the processor service value, so the additional tag factory can wait until production wiring demonstrates a need. `makeNTBSAdapterTag` remains useful if multiple adapter-specific processor layers will be built.

### S4. Use record-oriented, plain names

The current names mix events, lifecycle language, and stored adapter state. These values are records, and the processor assumes one external request per fresh T3 thread.

| Current                                                             | Plainer option                         | Reason                                                                                           |
| ------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [`NTBSLifecycle`](../../apps/server/src/ntbs/lifecycle.ts#L65)      | `NTBSRequestRecord`                    | It is the adapter's current stored record, not a process.                                        |
| [`ThreadEvent`](../../apps/server/src/ntbs/lifecycle.ts#L39-L50)    | `ThreadRequestRecord` or no base alias | Nothing emits it as an event.                                                                    |
| [`ThreadCreated`](../../apps/server/src/ntbs/lifecycle.ts#L52-L58)  | `PendingResponse`                      | The processor cares that this record still needs a response.                                     |
| [`ResponsePosted`](../../apps/server/src/ntbs/lifecycle.ts#L60-L63) | `RespondedRequest`                     | Names the terminal request state.                                                                |
| [`t3Data`](../../apps/server/src/ntbs/lifecycle.ts#L40-L49)         | `thread`                               | `record.thread.threadId` and `record.thread.userMessageId` state the contents directly.          |
| [`T3Context`](../../apps/server/src/ntbs/processor.ts#L48-L62)      | `ThreadTarget`                         | It contains only the project and base ref used to create a thread.                               |
| [`snapshot`](../../apps/server/src/ntbs/lifecycle.ts#L26-L31)       | `prompt` or `capturedText`             | The value is sent verbatim as the first user message; “snapshot” does not say what was captured. |

The recent removal of generic platform data is a good simplification and should not be reversed. Keeping one opaque, adapter-owned URI is easier to persist and recover. `sourceUri` could become `requestUri` to emphasize identity and addressability, but that rename is optional; the more important change is to validate it as non-empty.

### S5. Make the input contract executable

[`NTBSInput`](../../apps/server/src/ntbs/lifecycle.ts#L3-L37) is a plain TypeScript type whose strongest requirements exist only in comments. `sourceUri` may be empty, `snapshot` may be blank or exceed 120,000 characters, and the attachment array may exceed the provider limit of eight. The orchestration command accepts the values, while tighter provider validation occurs later, after resources and a lifecycle record can already exist.

Define an Effect schema for the inbound boundary and reuse [`PROVIDER_SEND_TURN_MAX_INPUT_CHARS` and `PROVIDER_SEND_TURN_MAX_ATTACHMENTS`](../../packages/contracts/src/orchestration.ts#L146-L147) together with [`ChatAttachment`](../../packages/contracts/src/orchestration.ts#L181-L182). Decode before claiming or creating resources. This reduces prose that can drift and gives every adapter one executable contract.

### S6. Consolidate the transitional test suite

The directory currently carries two harnesses and two processor test files:

- [`processor.test.ts`](../../apps/server/src/ntbs/processor.test.ts#L70-L85) describes a full happy path and missing-turn recovery, but its only test merely calls `process` without assertions ([`processor.test.ts:156–165`](../../apps/server/src/ntbs/processor.test.ts#L156-L165)).
- [`processor2.test.ts`](../../apps/server/src/ntbs/processor2.test.ts#L27-L171) is the more coherent layer harness and should become the sole `processor.test.ts`.
- Most of [`test-helpers.ts`](../../apps/server/src/ntbs/test-helpers.ts#L75) is an unfinished second copy of that harness and is not exported or used.
- [`createGitLayerMock`](../../apps/server/src/ntbs/test-helpers.ts#L34-L42) returns `input.refName` as the created worktree branch rather than `input.newRefName`, so a command assertion would observe the base commit as the thread branch.

Delete the no-assertion test and unused helper harness, rename `processor2.test.ts`, and grow that one harness around state transitions. The two files currently contain four tests, but only three assert behavior and none covers a complete request-to-response lifecycle.

## 2. Bugs, edge cases, and race conditions

### B1. Blocking before integration: no production code constructs or runs NTBS

The public entry points are [`makeNTBSProcessor`](../../apps/server/src/ntbs/processor.ts#L125-L133), [`makeNTBSAdapterTag`](../../apps/server/src/ntbs/adapter.ts#L95), and [`NTBSProcessor.run`](../../apps/server/src/ntbs/processor.ts#L69-L94), but their only consumers are the NTBS tests. There is no production adapter implementation. Consequently neither request processing nor startup recovery can execute. Treat this as integration status rather than an algorithm bug, but it is the first readiness item.

### B2. High: inbound deduplication is a check-then-act race

[`inFlightRequests`](../../apps/server/src/ntbs/processor.ts#L476-L480) protects only one processor instance. After that local check, [`findByRequest`](../../apps/server/src/ntbs/processor.ts#L687-L695) and resource creation are separate effects. Two processes, two processor instances, or an overlapping restart can both observe no record and create a worktree/thread for the same `sourceUri`. The adapter recommends a natural unique key but does not require atomic insertion or define conflict behavior.

Use the atomic `claimRequest` transition from S2 and enforce a unique key in adapter storage. The in-memory set may remain as a cheap duplicate suppressor, but it should not be the correctness boundary.

### B3. High: the durable record is written after irreversible resources are created

[`createT3Thread`](../../apps/server/src/ntbs/processor.ts#L493-L607) creates a worktree, dispatches `thread.create`, and runs setup before [`ThreadCreated` is saved](../../apps/server/src/ntbs/processor.ts#L697-L713). A process exit after successful dispatch, during setup, or before `save` leaves a real T3 thread/worktree with no request record. Redelivery sees no record and creates another.

Claim and persist the request before provisioning. Record generated thread/message IDs as soon as they are chosen, then make provisioning/recovery resume from that record. Deterministic IDs derived from the claim are another option, but are not required if the transition is durable.

### B4. High: a saved request can become dormant after turn-start failure

The processor saves `ThreadCreated` and then dispatches `thread.turn.start` ([`processor.ts:702–716`](../../apps/server/src/ntbs/processor.ts#L702-L716)). If turn start fails or the processing fiber is interrupted after the save, the record remains pending. A redelivery finds any existing lifecycle state and immediately returns ([`processor.ts:687–695`](../../apps/server/src/ntbs/processor.ts#L687-L695)). Only startup recovery reconciles the record ([`processor.ts:609–655`](../../apps/server/src/ntbs/processor.ts#L609-L655)).

Make `process` mean “ensure this request is processing”: when `findByRequest` returns a pending record, invoke the same idempotent reconciliation used at startup. Only a responded record should be an immediate no-op.

### B5. High: response delivery has a retry gap and a cross-process duplicate race

When response lookup, posting, or persistence fails, the event consumer logs the failure and continues ([`processor.ts:325–349`](../../apps/server/src/ntbs/processor.ts#L325-L349), [`processor.ts:730–740`](../../apps/server/src/ntbs/processor.ts#L730-L740)). With no later `thread.session-set` event, nothing retries until processor restart.

Conversely, two processor instances can both call `findMatchingResponseMessage`, both receive `null`, and both post before either saves `ResponsePosted`. The user-message semaphore is process-local ([`processor.ts:149–205`](../../apps/server/src/ntbs/processor.ts#L149-L205)). The recovery lookup protects the post-succeeded/save-failed window only after one response is visible; it is not an atomic exactly-once guarantee, and the adapter contract does not explain how it distinguishes a final response from an acknowledgement ([`adapter.ts:66–75`](../../apps/server/src/ntbs/adapter.ts#L66-L75)).

Use a durable response-delivery claim/outbox or an explicitly idempotent `postResponseOnce` adapter primitive. Add a bounded in-process retry; startup recovery should be the fallback rather than the normal retry mechanism.

### B8. Medium: event processing is serial and includes remote adapter I/O

[`Stream.runForEach`](../../apps/server/src/ntbs/processor.ts#L730-L741) processes domain events one at a time. A relevant event may perform adapter lookup, response search, response posting, and persistence before the next event is consumed ([`processor.ts:355–410`](../../apps/server/src/ntbs/processor.ts#L355-L410)). One slow or hung platform call therefore blocks outcomes for every other NTBS thread handled by that adapter and can grow the event backlog.

If this matters at observed volumes, route relevant events to fibers with bounded concurrency while retaining per-request serialization at the outcome transition.

### B9. Medium: unique requests have no resource bound

The API explicitly accepts unlimited concurrent distinct requests ([`processor.ts:69–82`](../../apps/server/src/ntbs/processor.ts#L69-L82)). Each can fetch `origin`, create a worktree, run setup, and start a full-access provider turn. A webhook burst can exhaust disk, git subprocesses, or provider capacity even though duplicate URIs are suppressed.

Put a configurable bound around active requests, ideally at a durable claim/queue boundary. At minimum, bound provisioning per project; concurrent fetches and worktree setup for the same repository provide little benefit.

### B10. Medium: invalid input fails after side effects instead of at admission

Because [`NTBSInput` invariants](../../apps/server/src/ntbs/lifecycle.ts#L3-L37) are not decoded, an empty URI can collapse unrelated requests onto one dedup key, and over-limit text or attachments can reach provider validation after resources and a pending record exist. Validate before the durable claim as described in S5 and return a stable rejected outcome rather than relying on a later provider error.

### B11. Low: an exact-turn error can use another turn's error text

The processor selects the turn by its recorded user-message ID, but for an errored turn it reads thread-wide `session.lastError` ([`processor.ts:263–309`](../../apps/server/src/ntbs/processor.ts#L263-L309)). If the thread later receives another turn, that text may describe the later session rather than the NTBS turn. Until errors are stored per turn, prefer generic failure text, or use `lastError` only when the selected turn is the current/latest turn.

### B12. Confidence gap: critical transitions are untested

The four current tests cover one no-assertion process call, unknown-event routing, durable redelivery deduplication, and ignoring an already-recorded response ([`processor.test.ts`](../../apps/server/src/ntbs/processor.test.ts), [`processor2.test.ts`](../../apps/server/src/ntbs/processor2.test.ts#L215-L281)). They do not cover a successful create/start/terminal-response lifecycle, missing-turn startup recovery, active-turn recovery, terminal-turn recovery, a response found remotely after local-save failure, concurrent recovery versus live completion, duplicate concurrent deliveries, or retry after turn-start failure.

After consolidating the harness, cover those transitions with controllable deferred adapter calls. In particular, turn the existing missing-turn TODO into a test that proves recovery reuses the stored `userMessageId` and does not start a second turn for pending/running records ([`processor.test.ts:84–85`](../../apps/server/src/ntbs/processor.test.ts#L84-L85)).

I specifically did not flag a projection/publication race: the orchestration engine applies projections in the same transaction before publishing each event to `streamDomainEvents`. I also did not treat best-effort setup-script failure or the documented temporary-branch leak as new NTBS bugs; both are explicit choices in the implementation ([`processor.ts:554–604`](../../apps/server/src/ntbs/processor.ts#L554-L604)).
