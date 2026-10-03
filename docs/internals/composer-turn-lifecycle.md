# Composer Turn Lifecycle — Known Issues & Remediation Plan

This document explains four reported problems with the chat composer and the
send / abort lifecycle, why they exist (they are mostly consequences of the
current optimistic client state model plus a missing turn-liveness guarantee,
not random bugs), and a plan to fix them.

## Reported symptoms

1. **Intermittent submit while a turn is processing.** After sending a message
   and while the agent (Codex / Claude / OpenCode) is processing, pressing Enter
   to submit another message _sometimes_ works and sometimes silently does
   nothing. Reloading the page reliably restores the ability to submit.
2. **Unresponsive abort button.** The Stop button frequently does nothing when
   clicked.
3. **Submit/abort button does not follow the conventional toggle.** In many
   other agent clients the primary button shows **Stop** while a turn runs, but
   as soon as you start typing a new message it becomes **Send**; clearing the
   input turns it back into **Stop**. T3 Code does not do this — the button is
   driven purely by turn status, and typing never converts it to Send.
4. **Turns stuck "running" for hours.** A turn can display a live
   **"Working for 8h 23m"** indicator long after any real work finished (the
   last tool call in the timeline shows as completed). The turn never settles,
   the elapsed timer keeps counting without bound, and — because of #2 — it
   cannot be aborted. Only a reload / session restart clears it. This is the
   end-stage of the same failure class as #1 and #2, plus a missing liveness
   guarantee (#4 below).

## Relevant architecture

### Session phase

`derivePhase(session)` (`apps/web/src/session-logic.ts:1381`) collapses the
server's `OrchestrationSessionStatus`
(`idle | starting | running | ready | interrupted | stopped | error`,
`packages/contracts/src/orchestration.ts:260`) into a 4-value client
`SessionPhase` (`apps/web/src/types.ts:19`):
`disconnected | connecting | ready | running`.

`phase === "running"` is the single gate that flips the composer's primary
button into a Stop button and blocks new sends.

### Optimistic local dispatch (`isSendBusy`)

Sends are optimistic. `useLocalDispatchState`
(`apps/web/src/components/ChatView.tsx:362`) records a `LocalDispatchSnapshot`
of the thread's `latestTurn` / `session` at send time
(`createLocalDispatchSnapshot`, `ChatView.logic.ts:398`). `isSendBusy` stays
true (`ChatView.logic.ts:419`) until the server state visibly _changes_ from
that snapshot, as judged by `hasServerAcknowledgedLocalDispatch`
(`ChatView.logic.ts:416-462`).

Acknowledgement is inferred — there is no explicit "command accepted" signal.
It is considered acknowledged when any of these differ from the snapshot:
`latestTurn.{turnId,requestedAt,startedAt,completedAt}`, `session.status`, or
`session.updatedAt`; or when a pending approval / pending user input / thread
error appears.

### The one toggle button

`ComposerPrimaryActions` (`apps/web/src/components/chat/ComposerPrimaryActions.tsx`)
branches in priority order:

1. `pendingAction` (plan Q&A) → Next / Submit.
2. `isRunning` → red **Stop** button (`onClick={onInterrupt}`), lines 126-140.
3. `showPlanFollowUpPrompt` → Refine / Implement.
4. default → **Send** (`type="submit"`), `disabled` when
   `isSendBusy || isConnecting || isEnvironmentUnavailable || !hasSendableContent`.

`isRunning` is wired to `phase === "running"`
(`ChatComposer.tsx:2545`). **Input content does not participate in the
branch** — only in whether the Send button is disabled.

### Send / interrupt transport

Both commands funnel through `dispatch` →
`request(ORCHESTRATION_WS_METHODS.dispatchCommand, …)`
(`packages/client-runtime/src/operations/commands.ts:78`). `request`
(`packages/client-runtime/src/rpc/client.ts:106`) resolves `currentSession()`;
if the socket is not live it **fails immediately** with
`EnvironmentRpcUnavailableError` (`client.ts:88-104`). The RPC session does not
retry (`retryTransientErrors: false`, `Schedule.recurs(0)`,
`packages/client-runtime/src/rpc/session.ts:99-102`); reconnect/backoff lives
only in `EnvironmentSupervisor`
(`packages/client-runtime/src/connection/supervisor.ts`). **Commands are not
queued across a reconnect** — they are dropped.

Server side, an interrupt is emitted as `thread.turn-interrupt-requested`
whether or not a `turnId` is supplied (`decider.ts:468-488`) and is applied
**by provider session**, not by turn id
(`ProviderCommandReactor.ts:879-898`).

## Root-cause analysis

### Issue 1 — intermittent submit, fixed by reload

`onSend` bails when `isSendBusy` is true (`ChatView.tsx:3903-3909`) and the
composer disables/ignores Enter on the same signal
(`collapsedComposerPrimaryActionDisabled`, `ChatComposer.tsx:1137`). So the
symptom is: **`isSendBusy` is stuck true.**

`isSendBusy` is derived, not timed. It only clears when
`hasServerAcknowledgedLocalDispatch` observes a _difference_ from the snapshot
taken at send time (`ChatView.logic.ts:432-461`). It gets stuck whenever that
difference never materialises on the client:

- **Sending a second message while a turn is already running.** The snapshot is
  taken with the running turn's ids/timestamps already populated. If the server
  queues/answers without producing a _distinct_ `latestTurn`/`session` change
  the client can see — or produces one that matches the snapshot's fields — the
  `phase === "running"` branch keeps returning `false` (`ChatView.logic.ts:440-454`)
  and the dispatch is never acknowledged.
- **A missed or coalesced projection update.** The acknowledgement depends on
  seeing the `updatedAt`/turn transition. A dropped WebSocket frame, a
  reconnect (`supervisor.ts`), or a projection snapshot that lands already in
  the post-transition state can skip the exact delta the heuristic is waiting
  for.
- **No timeout / no explicit ack.** Because acknowledgement is inferred from
  state diffing and there is no fallback timer, once the delta is missed the
  client waits forever.

Reloading rebuilds `localDispatch` as `null` from a fresh snapshot, so
`isSendBusy` is false again — which is exactly the reported workaround.

### Issue 2 — unresponsive abort

Two independent causes, both client-side (the server interrupts by session and
tolerates a missing `turnId`, so the payload shape is not the problem):

- **The Stop button is only rendered when `phase === "running"`**
  (`ComposerPrimaryActions.tsx:126`, gated by `ChatComposer.tsx:2545`). During
  the window where a send is in flight but the session has not yet reported
  `running` (`isSendBusy` true, `phase` still `ready`/`connecting`), the
  composer shows a **disabled Send spinner, not Stop** — there is no way to
  abort. Conversely if the client's `session.status` is stale (see Issue 1),
  the button state and the real provider state disagree.
- **Fire-and-forget dispatch over a possibly-down socket.** `onInterrupt`
  (`ChatView.tsx:4291`) calls `interruptThreadTurn` once. If the socket is
  reconnecting, `currentSession()` rejects immediately (`client.ts:93-99`) and
  the interrupt is dropped (no queue, no retry). Failures classified as
  "interrupted" are swallowed (`isAtomCommandInterrupted`, `ChatView.tsx:4297`),
  so the click produces no visible effect and no error.

`interruptTurn` does use the `urgentScheduler`
(`packages/client-runtime/src/state/threadCommands.ts:110`), so scheduling is
not the bottleneck — availability of the socket and visibility of the button
are.

### Issue 3 — button does not toggle on input content

This is a **design gap, not a defect**. `ComposerPrimaryActions` decides
Send-vs-Stop solely from turn status (`isRunning`); the draft's
`hasSendableContent` only toggles the Send button's `disabled` state, and is not
consulted in branch 2 (`ComposerPrimaryActions.tsx:126-228`). The conventional
behaviour (Stop when idle-of-input during a run, Send the moment the user types,
Stop again when the input is cleared) is simply not implemented. Implementing it
also removes the Issue 2 dead-zone, because a running turn with a non-empty
draft would expose Send while still allowing Stop via a secondary affordance.

### Issue 4 — turns stuck "running" for hours, unbounded timer

A turn is displayed as in-progress whenever `isLatestTurnSettled` returns false
(`apps/web/src/session-logic.ts:294-303`):

```ts
if (!latestTurn?.startedAt) return false;
if (!latestTurn.completedAt) return false; // no completion observed → "running"
if (!session) return true;
if (session.status === "running") return false;
return true;
```

The `MessagesTimeline` renders the "Working for …" row while `!latestTurnSettled`
(`ChatView.tsx:5126`), and `WorkingTimer` (`MessagesTimeline.tsx:1082-1102`)
computes `now − createdAt` on a 1 s interval with **no upper bound**. So the
label counts up forever as long as the turn is considered unsettled.

A turn only _becomes_ settled when the server applies a `turn.completed` (or
`session.exited`) event and sets `completedAt` / flips `session.status`
(`apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1257-1645`).
There is **no liveness guarantee** on that ever happening:

- **No per-turn stall / idle / heartbeat timeout anywhere.** The only timeouts
  in the provider layer are for _session load_ (90 s,
  `apps/server/src/provider/acp/AcpSessionRuntime.ts:49-50`). If a provider
  process hangs, its stdout stream stalls, or the terminal event is never
  emitted, the orchestration engine keeps the session `running` indefinitely.
- **A single dropped completion event is unrecoverable on the client.** Same
  fragility as Issue 1 — if the `turn.completed` projection frame is lost over a
  reconnect, the client's `session.status` stays `running` and `completedAt`
  stays null, so `isLatestTurnSettled` never flips.
- **Abort is the only recovery, and it is unreliable** (Issues 1 & 2), so the
  turn wedges until a reload or a server restart.

The "8h 23m" is therefore not evidence of work — it is a turn that lost (or
never received) its completion signal, with nothing on either side to time it
out. This is the single most user-visible consequence of the missing
acknowledgement/liveness model.

## Design principles

**The composer is never blocked by turn state.** A user must be able to type and
send messages regardless of whether a turn is running, stalled, or will never
complete. Turn liveness is a server/provider concern; it must not gate the
input. This is the primary requirement and it reframes the whole plan:

- Sending must **not** depend on `phase === "running"` or on the previous turn
  being settled. A hung turn (Issue 4) must never take the composer offline.
- `isSendBusy` may only represent the **in-flight send RPC itself** — a
  sub-second round-trip — never the lifetime of a turn. It must clear on the
  RPC's own resolution/failure (or a short watchdog), not on inferred turn
  progress.
- The only legitimate hard blocks on send are: no active thread, or the
  environment/socket being unavailable (and even then, prefer queueing the
  message over silently dropping it — see Phase 5).
- Enabling send while a turn runs requires the **server to accept a message
  during an active turn** (queue it for the next turn, or interrupt-then-send).
  That server contract is the gating dependency for this principle; see the
  open question on send-while-running semantics.

## Remediation plan

Ordered by value-to-risk. Phase 1 makes the composer always usable (the
principle above) and self-healing; Phase 2 makes abort always reachable; Phase 3
aligns the button UX with the convention; Phase 4 adds a liveness guarantee so a
lost/hung turn cannot wedge for hours; Phase 5 hardens the transport.

### Phase 1 — composer always usable + self-healing (fixes Issue 1, enforces the principle)

- **Stop gating send on turn state.** Remove `phase === "running"` from the
  composer's send/Enter disable
  (`collapsedComposerPrimaryActionDisabled`, `ChatComposer.tsx:1137`) and remove
  `isSendBusy` as a hard block in `onSend` (`ChatView.tsx:3903-3909`). Sending
  is allowed whenever there is sendable content and the environment is
  connected, regardless of whether a turn is running or stuck.
- **Redefine `isSendBusy` to the send RPC only.** It must reflect the in-flight
  `dispatchCommand` round-trip and clear on that RPC's own resolution/failure —
  not on inferred turn progress via `hasServerAcknowledgedLocalDispatch`
  (`ChatView.logic.ts:416-462`). Back it with a short watchdog so a lost
  response cannot pin it; a hung _turn_ no longer touches it at all.
- Prefer an **explicit acknowledgement** over state-diff inference: have
  `dispatchCommand` resolve with the accepted command / turn (or queued-message)
  id (`packages/client-runtime/src/operations/commands.ts:78`,
  `packages/contracts/src/orchestration.ts` command results).
- Reconcile local state on **reconnect / fresh snapshot**: when a full thread
  snapshot arrives, trust it over any stale in-flight flag so a missed delta
  cannot wedge the composer.
- Add regression tests to `ChatView.logic.ts` covering: send-while-running,
  send-while-stalled (turn never completes), snapshot equal to post-state, and
  reconnect mid-dispatch.

### Phase 2 — guarantee abort is always reachable and never silent (fixes Issue 2)

- **Decouple Stop visibility from `phase === "running"`.** Show Stop whenever
  there is an interruptible turn, including the optimistic `isSendBusy` window
  (i.e. `isRunning || isSendBusy` with an `activeTurn`/pending dispatch). Target
  `ChatComposer.tsx:2545` and `ComposerPrimaryActions.tsx:126`.
- **Do not swallow interrupt failures.** When the socket is unavailable, either
  queue the interrupt for delivery on reconnect or show an explicit, actionable
  error instead of treating `EnvironmentRpcUnavailableError` as a no-op
  (`ChatView.tsx:4291-4304`).
- Consider optimistic feedback on the Stop button (pressed/disabled state) so a
  click is always acknowledged in the UI even before the server confirms.

### Phase 3 — content-aware primary button + send-while-running semantics (fixes Issue 3)

- Change `ComposerPrimaryActions` so that when a turn is running **and** the
  draft has sendable content, the primary button is **Send** while Stop remains
  available as a secondary control; when the draft is empty, the primary button
  is **Stop**.
- Model the two send-while-running modes explicitly rather than picking one:
  - **Queue** — the message waits and is delivered when the current turn ends
    (Codex's default behaviour: queued messages sit until the turn completes).
    Surface queued messages in the composer/timeline so the user can see and
    ideally cancel/edit them while they wait.
  - **Steer** — inject the message into the running turn now (Codex "steer"),
    redirecting the agent mid-turn without a full interrupt. Expose this as an
    explicit action (e.g. modifier on Send, or a distinct control) since it is a
    force/override, not the default.
- This makes the "wait until the turn ends, or force a steer" reality first-class
  instead of implicit. Requires the server contract to distinguish queue vs steer
  per provider (see open question).
- Keep the plan Q&A / follow-up branches at higher priority than this toggle.

### Phase 4 — turn liveness guarantee (fixes Issue 4)

This is the phase that directly kills the "Working for 8h" state. Two layers:

- **Server-side stall detection (authoritative).** Track a last-activity
  timestamp per running turn in the orchestration engine and add a bounded
  idle/heartbeat timeout. If no provider stream activity (tokens, tool events,
  approvals) arrives within the window, emit a synthetic
  `turn.completed`/failed (e.g. status `stalled`) so `completedAt` is set and
  the session leaves `running`. Target the ingestion / reactor around
  `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1257-1645`
  and `ProviderCommandReactor.ts`. Also verify provider-process exit /
  `session.exited` always finalises the active turn (a crashed provider must not
  leave a `running` session).
- **Client-side settled reconciliation + honest timer (defensive).** When a full
  thread snapshot arrives, trust it over any stale `running` status; and cap /
  qualify the `WorkingTimer` — after an unreasonable threshold show an
  "unresponsive / may be stalled" state with a recover action instead of a bare
  ever-growing counter (`MessagesTimeline.tsx:1082-1102`,
  `isLatestTurnSettled` at `session-logic.ts:294`).

### Phase 5 — transport hardening (reduces recurrence of 1, 2 & 4)

- Introduce a small **outbound command queue** in the client runtime so
  `dispatch` for user-initiated commands (start turn, interrupt) survives a
  brief reconnect instead of failing at `currentSession()`
  (`packages/client-runtime/src/rpc/client.ts:88-124`). Bound it and drop with a
  visible notice on prolonged disconnect.
- Document and test the interaction between the supervisor's reconnect backoff
  (`supervisor.ts`, 1→16 s) and command delivery, so the acknowledgement model
  in Phase 1 has defined behaviour across reconnects.

## Open questions

- **Send-while-running semantics (queue vs steer).** A message sent during a
  running turn should support both **queue** (deliver after the turn ends —
  Codex's default) and **steer** (inject into the running turn now — Codex
  "steer"). Confirm what each provider (Codex / Claude / Cursor / OpenCode)
  supports, and how the server should model it: the current path emits a user
  message + turn-start on `thread.turn.start` (`decider.ts`) with no notion of a
  queued or steering message — determine whether concurrent turn-starts are
  queued, rejected, or need a new command/field to carry the queue-vs-steer
  intent.
- **Acknowledgement source of truth.** Confirm whether `dispatchCommand` can
  return an accepted-command id today, or whether the contract in
  `packages/contracts/src/orchestration.ts` needs a new result field.
- **Stall threshold & heartbeats.** What idle window counts as "stalled" per
  provider (Codex / Claude / Cursor / OpenCode), and do any of them emit a
  keepalive/heartbeat we can key off instead of a blind timeout? A long tool
  call or a slow model must not be misclassified as stalled. Confirm every
  provider path finalises the active turn on process exit.

## Upstream tracking (pingdotgg/t3code)

As of 2026-07-04 every symptom here is already reported upstream; all are **open
issues** and there are **no open PRs** addressing them. #231 is the only one
marked in progress.

- **Issue 1 — stuck send / can't send while working**
  - [#2173](https://github.com/pingdotgg/t3code/issues/2173) — Stuck 'working'
    icon after prompt, **can't send more prompts** (bug, needs-triage).
  - [#379](https://github.com/pingdotgg/t3code/issues/379) — Sending message box
    getting stuck (Linux app).
  - [#1048](https://github.com/pingdotgg/t3code/issues/1048) — Threads get stuck
    on "waiting for 0s".
- **Principle — must keep sending even when a turn won't complete**
  - [#1297](https://github.com/pingdotgg/t3code/issues/1297) — No way to
    background or kill a long-running process, **blocking further prompts/chats**.
- **Issue 2 — abort unreliable**
  - [#2573](https://github.com/pingdotgg/t3code/issues/2573) — Opencode: steering
    breaks session tracking and **stop doesn't work after steer**.
- **Issue 3 — send-while-running (queue vs steer)**
  - [#231](https://github.com/pingdotgg/t3code/issues/231) — feat: add **Steer and
    Queue** follow-up modes (enhancement, 🚧 In Progress). Directly matches Phase 3.
- **Issue 4 — turns stuck "running" for hours / lost completion**
  - [#917](https://github.com/pingdotgg/t3code/issues/917) — Proposal: **recover
    stuck running turns when turn/completed is lost** after long command
    execution. Directly matches Phase 4 (server-side liveness).
  - [#2644](https://github.com/pingdotgg/t3code/issues/2644) — Chat shows
    "working..." **indefinitely** after opencode CLI already finished.
  - [#2778](https://github.com/pingdotgg/t3code/issues/2778) — Session hung
    forever after spawning subagents.
  - [#3580](https://github.com/pingdotgg/t3code/issues/3580) — [orchestrator-v2]
    Grok steer rows vanish and **runs wedge on Working** after reply.
- **Phase 5 — transport / desync (contributing cause)**
  - [#3054](https://github.com/pingdotgg/t3code/issues/3054),
    [#2750](https://github.com/pingdotgg/t3code/issues/2750) — WS
    disconnect/reconnect loops leaving threads desynced on lossy links.
  - [#2065](https://github.com/pingdotgg/t3code/issues/2065) — thread becomes
    inconsistent after closing the app during execution.

## Key references

| Concern                                  | Location                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| Phase derivation                         | `apps/web/src/session-logic.ts:1381`                                         |
| `SessionPhase` type                      | `apps/web/src/types.ts:19`                                                   |
| Session status enum                      | `packages/contracts/src/orchestration.ts:260`                                |
| Optimistic dispatch state                | `apps/web/src/components/ChatView.tsx:362-421`                               |
| Ack heuristic                            | `apps/web/src/components/ChatView.logic.ts:416-462`                          |
| `onSend` guard                           | `apps/web/src/components/ChatView.tsx:3900-3909`                             |
| Enter handler                            | `apps/web/src/components/chat/ChatComposer.tsx:1727-1758`                    |
| Primary button branch                    | `apps/web/src/components/chat/ComposerPrimaryActions.tsx:75-228`             |
| `onInterrupt`                            | `apps/web/src/components/ChatView.tsx:4291-4304`                             |
| Interrupt input builder                  | `apps/web/src/components/ChatView.logic.ts:77-86`                            |
| Turn-settled predicate                   | `apps/web/src/session-logic.ts:294-303`                                      |
| "Working for" row + unbounded timer      | `apps/web/src/components/chat/MessagesTimeline.tsx:1053-1102`                |
| `activeTurnInProgress` gate              | `apps/web/src/components/ChatView.tsx:5126`                                  |
| Turn completion ingestion                | `apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts:1257-1645` |
| Only load-time timeout (no turn timeout) | `apps/server/src/provider/acp/AcpSessionRuntime.ts:49-50`                    |
| Dispatch funnel                          | `packages/client-runtime/src/operations/commands.ts:78`                      |
| RPC availability gate                    | `packages/client-runtime/src/rpc/client.ts:88-124`                           |
| No RPC-level retry                       | `packages/client-runtime/src/rpc/session.ts:99-102`                          |
| Reconnect backoff                        | `packages/client-runtime/src/connection/supervisor.ts:32-104`                |
| Server interrupt (by session)            | `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts:879-898`     |
| Interrupt decider                        | `apps/server/src/orchestration/decider.ts:468-488`                           |
