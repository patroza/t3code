# NTBS directory review

**Status:** Review notes (Claude Code, 2026-08-14; reconciled with the monitor-free processor on 2026-08-15). Addressed findings have been removed, so numbering gaps are intentional.

**Scope:** The six files in [`apps/server/src/ntbs`](../../apps/server/src/ntbs/) and the orchestration/projection behavior they directly depend on.

The processor/adapter boundary is generally clean. Startup recovery and the live `thread.session-set` listener now have distinct roles: recovery starts a missing turn or immediately reconciles a terminal one, while active turns are left to the listener. The remaining findings are refinements, ordered by practical impact.

---

## 1. Simplifications, naming, and contracts

### API and business logic

**S6. Consolidate the test harnesses.**

Most of [`test-helpers.ts`](../../apps/server/src/ntbs/test-helpers.ts#L99) is unexported and unused; only `createGitLayerMock` and `createAdapterRequest` are imported by [`processor.test.ts`](../../apps/server/src/ntbs/processor.test.ts#L17). Meanwhile, [`processor2.test.ts`](../../apps/server/src/ntbs/processor2.test.ts#L27) contains a separate, already-divergent harness. Its state-service design is the stronger base, including the `threadLookups` queue used for synchronization.

Keep one harness, move any reusable pieces into `test-helpers.ts`, and merge the tests into one `processor.test.ts`. The current “happy case” in [`processor.test.ts`](../../apps/server/src/ntbs/processor.test.ts#L156-L165) has no assertion, and its `eventReceived` deferred is created but never observed ([`processor.test.ts:22–42`](../../apps/server/src/ntbs/processor.test.ts#L22-L42)). Also fix the worktree fake: it reports `input.refName` as the created branch instead of `input.newRefName` ([`test-helpers.ts:34–42`](../../apps/server/src/ntbs/test-helpers.ts#L34-L42)).

**S7. Deduplicate the fixed runtime settings.**

`runtimeMode: "full-access"` and `interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE` are repeated in both turn and thread creation ([`processor.ts:223–240`](../../apps/server/src/ntbs/processor.ts#L223-L240), [`processor.ts:538–552`](../../apps/server/src/ntbs/processor.ts#L538-L552)). One module-level constant would state that policy once and provide the natural home for a future override.

### Naming and contracts

**N2. `ThreadEvent` is a stored record, not an event.**

[`ThreadEvent`](../../apps/server/src/ntbs/lifecycle.ts#L39-L50) is the common stored shape for the two lifecycle states. `ThreadRecord` or `LifecycleBase` would say what it is. The contract fields are also mutable while the processor treats them as immutable; make `sourceUri`, `snapshot`, `attachments`, `t3Data`, its nested IDs, `state`, and `responseMessageId` `readonly` ([`lifecycle.ts`](../../apps/server/src/ntbs/lifecycle.ts#L3-L65)).

**N3. Remove or correct stale comments.**

- The architecture block still refers to generic `NTBSInput<P>`, although the generic platform data was removed ([`processor.ts:35–39`](../../apps/server/src/ntbs/processor.ts#L35-L39)).
- The event path says it selects the “last user message,” but it uses the one original user-message ID stored for the request; no selection occurs ([`processor.ts:377–381`](../../apps/server/src/ntbs/processor.ts#L377-L381)).
- Two outcome-lock comments still refer to timeout handling, which no longer exists ([`processor.ts:179–182`](../../apps/server/src/ntbs/processor.ts#L179-L182), [`processor.ts:383–388`](../../apps/server/src/ntbs/processor.ts#L383-L388)).
- The recovery-test TODO still says recovery should “monitor” the turn, and the second harness still mentions monitor baselines ([`processor.test.ts:84–85`](../../apps/server/src/ntbs/processor.test.ts#L84-L85), [`processor2.test.ts:36–38`](../../apps/server/src/ntbs/processor2.test.ts#L36-L38)).
- `acknowledge` returns `Effect<void>`, not a platform message identifier ([`adapter.ts:38–43`](../../apps/server/src/ntbs/adapter.ts#L38-L43)).
- The adapter, not the processor, creates the T3 attachment references passed through by the input ([`lifecycle.ts:32–36`](../../apps/server/src/ntbs/lifecycle.ts#L32-L36)).
- Fix “idenitifier” in the `postResponse` documentation ([`adapter.ts:44–54`](../../apps/server/src/ntbs/adapter.ts#L44-L54)).

**N4. `adapter.save` does not state its upsert semantics or identity key.**

The processor writes `thread.created` and later replaces it with `thread.response.posted` ([`processor.ts:340–346`](../../apps/server/src/ntbs/processor.ts#L340-L346), [`processor.ts:702–713`](../../apps/server/src/ntbs/processor.ts#L702-L713)), but the adapter contract only says “stores a lifecycle state” ([`adapter.ts:32–36`](../../apps/server/src/ntbs/adapter.ts#L32-L36)). State explicitly that this is an upsert and identify its key. The tests currently assume records are keyed by `threadId`, while `sourceUri` is documented as the durable request identity.

**N5. The 120,000-character input limit names no enforcer.**

[`NTBSInput.snapshot`](../../apps/server/src/ntbs/lifecycle.ts#L26-L31) documents the limit, but the processor does not validate it. Say that adapters must enforce it before calling `process`, or make the contract executable as proposed in the other review.

**N6. Clarify who owns non-answer response text.**

The processor supplies fixed English text for empty completions, failures, and cancellations ([`processor.ts:289–315`](../../apps/server/src/ntbs/processor.ts#L289-L315)), while [`NTBSResponse`](../../apps/server/src/ntbs/adapter.ts#L14-L17) carries both the semantic type and rendered text. If adapters may localize or replace this copy, document `text` as a default; otherwise the current contract means every platform must post the processor's prose verbatim.

**N8. Spell out NTBS once.**

None of the three production files expands the acronym. The architecture heading is the natural place to write “Non-Turn-Based Surfaces” ([`processor.ts:23–26`](../../apps/server/src/ntbs/processor.ts#L23-L26)).

---

## 2. Bugs, edge cases, and race conditions

**B1. A turn that never materializes leaves the request unanswered until restart.**

`thread.turn.start` first creates a pending projected row. If the provider session settles before adopting it, the projection deliberately deletes that row ([`ProjectionPipeline.ts:1389–1406`](../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts#L1389-L1406)). The terminal `thread.session-set` event still reaches the NTBS listener, but [`resolveT3Outcome`](../../apps/server/src/ntbs/processor.ts#L263-L275) treats the missing turn as an error; the event loop logs the failure and moves on ([`processor.ts:730–740`](../../apps/server/src/ntbs/processor.ts#L730-L740)). No final response is posted.

Startup recovery eventually sees the missing turn and starts it again ([`processor.ts:615–630`](../../apps/server/src/ntbs/processor.ts#L615-L630)), but that makes a restart the only recovery path and may repeat a deterministic provider-start failure. Treat a missing turn as a state: inspect the thread session, return “still pending” for `null`/`starting`/`running`, produce a failure for a settled session (using `lastError` when appropriate), and treat a missing thread as cancellation. Keep restart recovery as the bounded retry path rather than restarting from the live terminal-event path.

**B2. Startup recovery can race normal processing into two turn-start commands.**

`process` saves `ThreadCreated` immediately before starting the turn ([`processor.ts:687–716`](../../apps/server/src/ntbs/processor.ts#L687-L716)). If `run` loads that record during the small save-to-dispatch window, recovery also sees no turn and starts it ([`processor.ts:743–771`](../../apps/server/src/ntbs/processor.ts#L743-L771)). The decider queues a second start when the first has already established `pendingTurnStart` ([`decider.ts:1171–1209`](../../apps/server/src/orchestration/decider.ts#L1171-L1209)); it does not make two commands with different command IDs idempotent merely because their message ID matches.

The narrow fix is to have `recoverThread` skip records whose `sourceUri` is present in [`inFlightRequests`](../../apps/server/src/ntbs/processor.ts#L476-L480). That closes the duplicate-dispatch window without reintroducing monitor tracking; a failed normal turn-start remains the separate redelivery/reconciliation issue described in the other review.

**B5. A crash between T3 thread creation and `adapter.save` orphans resources.**

[`createT3Thread`](../../apps/server/src/ntbs/processor.ts#L493-L607) creates the worktree, dispatches `thread.create`, and runs setup before the durable NTBS record is written ([`processor.ts:697–713`](../../apps/server/src/ntbs/processor.ts#L697-L713)). A process exit after successful thread creation but before `save` leaves a thread/worktree that redelivery cannot discover, so redelivery creates another. This may be acceptable at-least-once behavior for the first version, but it should be recorded explicitly as a chosen crash window.

**B7. Serial event handling creates head-of-line blocking.**

[`Stream.runForEach`](../../apps/server/src/ntbs/processor.ts#L730-L741) handles session events sequentially, and one event can perform adapter reads plus a remote response post before the next event is consumed ([`processor.ts:355–410`](../../apps/server/src/ntbs/processor.ts#L355-L410)). One slow Discord/Jira call therefore delays all other outcomes for the same adapter. This is reasonable for initial volumes; add a comment that serialization is intentional, then introduce bounded per-event concurrency only if measurements justify it.

**B8. Failed final-response delivery waits for another event or restart.**

If terminal-event handling fails while searching for, posting, or recording the response, the event consumer logs the error and continues ([`processor.ts:325–349`](../../apps/server/src/ntbs/processor.ts#L325-L349), [`processor.ts:730–740`](../../apps/server/src/ntbs/processor.ts#L730-L740)). The T3 event stream does not replay that event, so another relevant session event or startup recovery is required before the processor retries. A small bounded retry around terminal-event reconciliation would close this gap. `findMatchingResponseMessage` already protects the post-succeeded/save-failed retry window from an ordinary duplicate ([`processor.ts:330–346`](../../apps/server/src/ntbs/processor.ts#L330-L346)).

---

## Reviewed and deliberately not flagged

- `ensureUniqueOutcome` and its per-message semaphore correctly serialize the startup-recovery/live-event race and clean up after the response is recorded ([`processor.ts:149–205`](../../apps/server/src/ntbs/processor.ts#L149-L205)).
- Subscribing before recovery is the right ordering for a hot event stream ([`processor.ts:768–773`](../../apps/server/src/ntbs/processor.ts#L768-L773)).
- `resolveWorktreeBase` has sensible fetch and ref-resolution fallbacks ([`processor.ts:412–470`](../../apps/server/src/ntbs/processor.ts#L412-L470)).
- Worktree cleanup on `thread.create` failure, including the documented temporary-branch leak, is deliberate ([`processor.ts:538–588`](../../apps/server/src/ntbs/processor.ts#L538-L588)).
- Consulting `findMatchingResponseMessage` on every response attempt is the idempotency net for the post-then-crash window and belongs in the common path ([`processor.ts:318–349`](../../apps/server/src/ntbs/processor.ts#L318-L349)).
