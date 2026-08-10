# Adversarial review: `createT3Thread` (NTBS processor)

Target: `createT3Thread` in [apps/server/src/ntbs/processor.ts](../../apps/server/src/ntbs/processor.ts)
(lines ~219–308 at review time).

Compared against its two existing siblings, which encode lessons this code has not absorbed yet:

- Jira auto-create flow: [apps/server/src/jira/JiraIssueBridge.ts](../../apps/server/src/jira/JiraIssueBridge.ts) (~395–499)
- ws bootstrap flow: [apps/server/src/ws.ts](../../apps/server/src/ws.ts) (~1098–1156)

## Business-logic cracks (ranked)

### 1. Worktree leak on `thread.create` failure — FIXED

### 2. Every error cause is thrown away — FIXED

### 3. `t3Context.baseRef` is used raw — FIXED

The field is renamed `revision` → `baseRef` with its contract documented on `T3Context` and in
`ntbs-architecture.md`. `resolveWorktreeBase` implements the resolution: fetch `origin` (failure
tolerated separately, so an offline host still resolves against its last-known tracking ref), then
prefer the remote state via `resolveRemoteTrackingCommit` (passing `baseRefName` for merge-base
metadata), falling back to raw passthrough where git resolves the ref itself and a genuine failure
surfaces from `createWorktree` with its cause. No new `GitWorkflowService` surface was needed.

Deferred detail: empty `baseRef` is not rejected up front — it fails in `createWorktree` with a git
cause instead of a crisp contract error. Revisit when the first inbound layer produces the value.

### 4. Missing `deferDependencyInstall` — FIXED

`createT3Thread` now passes `deferDependencyInstall: true` to `createWorktree`, matching the ws
pattern, since setup scripts run afterwards.

### 5. Duplicate-request race (adjacent — `processAdapterRequest`) — MOSTLY FIXED

Concurrent duplicates are now refused, not raced. The design:

- `NTBSAdapter.getRequestKey(request)` defines the stable identity of a platform request
  (deterministic, distinct per request, stable across redeliveries) — the same identity
  `findByRequest` looks up.
- `processAdapterRequest` keeps an in-flight `Set` of keys: check-and-add happens synchronously
  before the first yield (single-threaded, so no race), a present key drops the duplicate with a
  debug log, and `Effect.ensuring` — wrapping only the admitted work, so a dropped duplicate
  cannot erase the winner's key — removes the key on success, failure, or interruption.
- `findByRequest` remains as the durable dedup for later redeliveries (after completion or
  restart); the set only covers requests running right now.
- Waiting/queueing duplicates behind the winner was considered and rejected: reliability is the
  winner's own job (a bounded `Effect.retry` around creation — still TODO), not a side effect of a
  duplicate happening to be queued.

Remaining follow-up, deferred to the adapter storage schema work: a unique constraint on the
request key for stored `ThreadStarted` records, as the durable backstop for what the in-process
set cannot see (crash mid-creation, multi-process future).

(The `return Effect.void` smell noted here earlier is fixed — both sites use a bare `return`.)

## Simplification / abstraction

### Smaller cleanups

- `buildTemporaryWorktreeBranchName(() => threadUUID)` works and is a tested pattern
  (`packages/shared/src/git.test.ts`), but it ignores the callback's `byteLength` parameter and
  truncates the UUID to 8 hex chars — to a reader it looks like a bug. Either a short comment or a
  dedicated `buildWorktreeBranchNameFromThreadId(threadUUID)` wrapper in `shared/git` would make
  the intent explicit.

## Deliberate choice needing a conscious sign-off

`runtimeMode: "full-access"` for threads triggered by _external platform actors_. Jira does the
same, so it is consistent — but it means anyone who passes the platform trigger/actor check gets an
unrestricted agent in the repo. Fine if the actor checks are the trust boundary; write that down
where the boundary is enforced.
