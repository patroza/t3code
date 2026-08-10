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

### 5. Duplicate-request race (adjacent — `processAdapterRequest`)

Not in `createT3Thread` itself, but directly feeds it. Still open:

- The `findByRequest` → create sequence has no atomicity, and webhooks _do_ redeliver
  concurrently. Two identical deliveries both pass the check and both create threads. Queuing is
  explicitly deferred, but at minimum the adapter's `ThreadStarted` record insert should be
  unique-keyed on the platform request so the second creation fails loudly.

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
