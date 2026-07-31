# Provider Turn Startup and Recovery

This runbook covers provider turns that remain `pending` or `running`, especially when new threads
also stop starting. It documents the current recovery procedure and the product changes required to
prevent one provider session from blocking unrelated threads.

For client-side composer state, missing completion events, and the unbounded **Working for...**
indicator, see [Composer Turn Lifecycle](../internals/composer-turn-lifecycle.md). The failure mode in
this runbook is server-side command dispatch and provider-session recovery.

## Recognize the failure mode

Use the scope of the failure to choose the first action:

| Observation                                            | Likely scope                              | First action                                                  |
| ------------------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------- |
| One running thread is stale, but new threads start     | One provider turn or session              | Use **Abort**, then **Stop session** if needed                |
| A new thread remains pending for more than two minutes | Provider command dispatch may be blocked  | Check for other active pending starts                         |
| Several unrelated providers/projects stop starting     | Global provider command worker is blocked | Restart the server and let startup reconciliation replay work |
| HTTP responds, but turns do not start                  | Process liveness only                     | Do not treat a generic HTTP 200 as command readiness          |

Do not repeatedly send the same prompt while its turn is pending. Startup reconciliation replays
the persisted request, so manually resending can produce duplicate work or external side effects.

## Why unrelated threads can become stuck

Provider intent events are enqueued into one `DrainableWorker` in
[`ProviderCommandReactor`](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts).
`DrainableWorker` processes one item at a time. A turn start calls `ensureSessionForThread`, which
can synchronously wait for `providerService.startSession` before releasing that worker.

The current path has four important properties:

1. Provider session startup has no reactor-level deadline.
2. The command worker is global rather than keyed by thread.
3. The session reaper skips sessions with an active turn, even if the provider process is wedged.
4. Pending-start replay runs during startup; there is no equivalent periodic pending-start sweeper.

Consequently, a single provider startup that never resolves causes head-of-line blocking: later
turn starts, interrupts, and session-stop requests are persisted but cannot pass the blocked worker.
The process can continue serving HTTP throughout the failure.

Startup recovery is also intentionally blocking. It recovers interrupted turns first, then replays
pending starts with bounded concurrency. Each interrupted recovery starts/resumes a provider session
and sends a continuation without a reconciliation deadline. It also scans persisted orchestration
events to recover the exact matching start request. A slow provider or a large event history can
therefore make startup readiness take minutes.

## Diagnose safely

### 1. Check the service, but do not confuse liveness with readiness

For a systemd installation:

```bash
systemctl is-active t3code-server.service
systemctl show t3code-server.service \
  -p MainPID -p NRestarts -p Restart -p WatchdogUSec -p MemoryCurrent -p MemoryPeak
```

An active process or successful request to the web origin proves only that the listener responds.
Unless a deployment exposes a real readiness endpoint, it does not prove that the provider command
worker is draining.

### 2. Find old pending starts on active threads

Set `T3_STATE_DB` to the deployment's absolute `state.sqlite` path, then run:

```bash
sqlite3 -header -column "$T3_STATE_DB" "
SELECT
  turn.thread_id,
  substr(thread.title, 1, 60) AS title,
  turn.state AS turn_state,
  session.status AS session_state,
  runtime.status AS runtime_state,
  turn.requested_at
FROM projection_turns AS turn
JOIN (
  SELECT thread_id, max(row_id) AS row_id
  FROM projection_turns
  GROUP BY thread_id
) AS latest ON latest.row_id = turn.row_id
JOIN projection_threads AS thread ON thread.thread_id = turn.thread_id
LEFT JOIN projection_thread_sessions AS session ON session.thread_id = turn.thread_id
LEFT JOIN provider_session_runtime AS runtime ON runtime.thread_id = turn.thread_id
WHERE thread.deleted_at IS NULL
  AND thread.archived_at IS NULL
  AND turn.state = 'pending'
  AND datetime(turn.requested_at) < datetime('now', '-2 minutes')
ORDER BY turn.requested_at;
"
```

Archived or deleted threads can retain historical pending projection rows. Excluding them prevents
those rows from being mistaken for live failures.

A long-running turn is not necessarily stuck: models and tools can legitimately run for many
minutes. For a `running` turn, inspect its most recent provider activity before interrupting it.

### 3. Inspect focused recovery logs

```bash
journalctl -u t3code-server.service --since "30 minutes ago" -o cat --no-pager \
  | rg "provider restart reconciliation|restart recovery|pending provider turn start|server is ready"
```

Useful messages include:

- `provider restart reconciliation candidates loaded`
- `provider turn restart recovery accepted`
- `provider turn restart recovery failed`
- `pending provider turn start replay enqueued`
- `pending provider turn start reconciliation skipped`
- `T3 Code server is ready`

A skipped archived/deleted thread is expected. A replay enqueue means the persisted request was
found and submitted to the command worker; verify that it subsequently becomes `running` or reaches
a terminal state.

## Recover

### One affected thread

If unrelated new threads still start:

1. Use **Abort** for the running turn.
2. If it remains stale, use **Stop session**.
3. Retry only after the thread returns to a non-running session state.

Both commands currently use the same global worker. If unrelated starts are also pending, these
controls may be queued behind the blockage and a restart is the reliable recovery.

### Several affected threads

Restart the service through its service manager:

```bash
sudo systemctl restart t3code-server.service
```

Follow a filtered journal in another terminal:

```bash
journalctl -fu t3code-server.service -o cat \
  | rg --line-buffered \
      "candidates loaded|recovery accepted|recovery failed|replay enqueued|server is ready"
```

Wait for `T3 Code server is ready`. Re-run the pending-start query and verify affected threads move
to `running`, `completed`, or `error`.

Do not edit `state.sqlite` to force a state transition. The event log, turn projection, session
projection, and persisted provider binding must remain consistent for replay to be safe.

### Emergency stop when graceful shutdown hangs

The service manager should be configured with a bounded stop timeout. If that timeout is exceeded
and the service still has wedged provider children, an operator may terminate the complete service
cgroup and start it again:

```bash
sudo systemctl kill --kill-whom=all --signal=SIGKILL t3code-server.service
sudo systemctl start t3code-server.service
```

This is an emergency action. It interrupts all active turns. Startup reconciliation attempts to
resume interrupted turns, but resumed agents must verify external state before repeating writes,
deployments, issue transitions, or other non-idempotent tool calls.

## Prevention work

### P0: contain a stalled provider startup

- Add a bounded deadline around `providerService.startSession` in normal turn startup and restart
  recovery. Convert timeout into a visible thread/session error and release the worker.
- Apply a deadline to recovery continuation `sendTurn` as well.
- Replace the global serial provider-command worker with per-thread ordering and bounded global
  concurrency. Commands for one thread must stay ordered without blocking unrelated threads.

Acceptance tests:

- A never-resolving session start for thread A does not prevent thread B from starting.
- A timed-out start settles thread A as an actionable error rather than leaving it pending.
- Interrupt and stop remain usable for unrelated threads while one provider is wedged.

### P1: recover without a process restart

- Add a periodic sweeper for active pending starts older than a bounded threshold.
- Replay only when the exact persisted `threadId + messageId + requestedAt` event exists.
- Preserve startup recovery's idempotency and skip archived/deleted threads.
- Enhance the session reaper to distinguish real active work from an active-turn marker with no
  provider heartbeat or runtime progress.

Acceptance tests:

- An orphaned pending start is replayed exactly once without restarting the server.
- A missing persisted event becomes a visible failure instead of an infinite pending row.
- A stale active-turn marker is settled without reaping a provider that is still producing activity.

### P1: expose command readiness

Provide separate endpoints:

- `/livez`: the process and event loop are responsive.
- `/readyz`: startup reconciliation is complete, the provider command worker is draining, and its
  oldest queued item is younger than the allowed threshold.

Readiness should become unhealthy when startup/reconciliation exceeds a deadline or command queue
age indicates head-of-line blocking. Export queue depth, oldest-item age, provider start duration,
recovery duration, replay outcome, and timeout counters as low-cardinality metrics.

### P2: deployment watchdog and shutdown hardening

- Monitor `/readyz`, not the web origin. Alert on the first sustained failure and restart only
  after consecutive failures to avoid interrupting work during a transient provider launch.
- Configure the service manager with restart-on-failure and a bounded stop timeout.
- Ensure graceful shutdown explicitly terminates provider/tool children before the timeout.
- Record process exit reason, memory peak, and kernel OOM evidence. Do not infer OOM from a
  `SIGKILL` alone.

Hostnames, credentials, resource limits, alert routing, and deployment-specific restart automation
belong in the private operations repository, not this product repository.

## Incident pattern observed on 2026-07-31

The observed deployment had one stale active provider turn and multiple unrelated pending starts.
The service process and HTTP listener remained alive. An earlier service process had exited by
`SIGKILL`, but kernel logs did not show an OOM kill; the kill source was not proven.

The observed service configuration used `Restart=on-failure`, a five-second restart delay, a
120-second stop timeout, and `KillMode=mixed`. It had no systemd watchdog or memory limit. The
terminated service cgroup reported a 13.9 GB memory peak, but that alone does not establish OOM as
the cause of the signal.

Timeline (UTC):

| Time        | Observation                                                                          |
| ----------- | ------------------------------------------------------------------------------------ |
| 08:41:53    | Main process exited with `SIGKILL`; systemd killed remaining provider/tool children  |
| 08:41:58    | `Restart=on-failure` started a replacement process                                   |
| 08:42:00    | Startup found three interrupted-turn and five pending-start candidates               |
| 09:11:07    | A later provider start entered the command path and did not settle                   |
| 09:19–09:26 | Unrelated provider types/projects accumulated pending starts behind it               |
| 09:32:33    | The service was restarted to force startup reconciliation                            |
| 09:32:34    | Reconciliation found three interrupted-turn and nine pending-start candidates        |
| 09:33:31    | Active pending starts were replayed; historical archived/deleted starts were skipped |
| 09:35:13    | The last affected active turn reached `completed`                                    |

A service restart loaded interrupted-turn and pending-start candidates. Recovery continued the
interrupted provider turn, replayed active pending starts, skipped historical starts for archived or
deleted threads, and allowed the affected turns to complete. No database rows were manually edited.

This incident demonstrates two independent safeguards that are both required:

1. crash/restart reconciliation must remain idempotent and observable; and
2. normal runtime dispatch must isolate threads and time out wedged provider startup so restart is
   not the ordinary recovery mechanism.

## Code references

- [`ProviderCommandReactor`](../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts):
  turn startup, interrupt/stop handling, and startup reconciliation.
- [`DrainableWorker`](../../packages/shared/src/DrainableWorker.ts): current serial queue semantics.
- [`ProviderRestartRecovery`](../../apps/server/src/provider/ProviderRestartRecovery.ts): persisted
  restart-recovery candidate selection.
- [`ProviderSessionReaper`](../../apps/server/src/provider/Layers/ProviderSessionReaper.ts): periodic
  inactive-session cleanup and active-turn skip behavior.
- [`serverRuntimeStartup`](../../apps/server/src/serverRuntimeStartup.ts): command readiness during
  startup.
