# Directories: workspaceRoot, worktreePath, cwd

Three names, but only **two real places on disk**. `cwd` is not a third place — it is a parameter naming which of the two a git command should run in.

## The two places

**`project.workspaceRoot`** — the repository the user registered as the project (`OrchestrationProject.workspaceRoot`, stored on the project row). It is the _source_ repository: fetches, ref resolution, and `git worktree add`/`remove` all run here. It may be a **bare** repo — bare is explicitly supported for exactly this plumbing (`allowBare` in `GitWorkflowService`), because a thread never works inside it.

**`thread.worktreePath`** — the per-thread checkout minted by `git worktree add`, recorded on the thread row by `thread.create` (or `thread.meta.update`). Nullable: a thread without one works directly in `workspaceRoot`. When `createWorktree` is called with `path: null`, the driver derives the path itself (`GitVcsDriverCore.createWorktree`):

```
<t3-home>/worktrees/<basename(workspaceRoot)>/<branch with "/" → "-">
```

## The one rule

Everything that runs "inside the thread's code" — provider sessions, terminals, checkpoints, setup scripts, title generation — resolves its directory as:

```ts
effectiveCwd = thread.worktreePath ?? project.workspaceRoot;
```

Canonical helper: `resolveThreadWorkspaceCwd` (`apps/server/src/checkpointing/Utils.ts`). Beware: some call sites bind the _resolved_ value to a parameter named `workspaceRoot` (e.g. `issueAssetUrl` in `ws.ts`) — read the resolution, not the name.

## Which place does each gateway call use?

| Operation                                                    | `cwd` to pass                         |
| ------------------------------------------------------------ | ------------------------------------- |
| `remoteExists`, `fetchRemote`, `resolveRemoteTrackingCommit` | `workspaceRoot`                       |
| `createWorktree`, `removeWorktree`                           | `workspaceRoot` (+ `path` = worktree) |
| status / branch ops on the thread's work                     | `worktreePath`                        |
| setup scripts (`runForThread`)                               | `worktreePath` (+ `projectId`)        |

So `provisionThread` is (mirroring `processor.old.ts#createT3Thread`):

1. `workspaceRoot = getProject(state.t3.projectId).workspaceRoot` — looked up fresh, never stored.
2. `worktreePath = deriveDefaultWorktreePath(...)` (see below), then `createWorktree({ cwd: workspaceRoot, refName: startCommitSha, baseRefName: startBranchName, newRefName: worktreeBranchName, path: worktreePath, deferDependencyInstall: true })`
3. `thread.create` with `{ branch: worktreeBranchName, worktreePath }`
4. `runForThread({ threadId, projectId, worktreePath })`

## Should `WorkCoordinates` reference a path?

**`workspaceRoot`: no.** It is live project state, always derivable from `projectId`, and can change
if the project is re-registered or moved. A stored copy in a durable exchange record goes stale;
coordinates should stay identity + pinned git state.

**`worktreePath`: no — derive it, for the same reason.** The path is fully determined by
`worktreeBranchName` (already in the coordinates) joined with live state: `worktreesDir`
(ServerConfig) and `basename(project.workspaceRoot)`. Storing the absolute path would bake the
same staleness in — if t3-home moves, the exchange DB moves with it, and a stored path would point
at the old home while a derived one stays correct by construction. Identity lives in the durable
record; location is computed from live state.

What that requires:

- **One shared helper.** The formula lives inline in `GitVcsDriverCore.createWorktree` today.
  Extract `deriveDefaultWorktreePath({ worktreesDir, workspaceRoot, branchName })` and use it for
  both the driver's `path: null` fallback and the gateway, so they cannot drift.
- **Derive once per provision attempt**, then pass the value explicitly as `path` to
  `createWorktree` — the concrete value is needed anyway for the reentrancy checks:
  - path exists on disk → skip `worktree add`
  - branch exists, path missing → `worktree add <path> <branch>` without `-b` (the recreate
    pattern in `ws.ts` bootstrap)
  - thread projected → skip `thread.create`
- **After `thread.create`, stop deriving.** The thread row's `worktreePath` records the path
  actually used and is the source of truth from then on (the `?? workspaceRoot` rule, cleanup,
  restore). Derivation only covers the window before the thread exists.
- **Accepted degradation:** if the formula or the project's path changes inside the crash window,
  the retry derives a new path, finds branch-exists/path-missing, and recovers via the
  no-`-b` add — leaking one orphan directory, the same class of accepted leak as the branch.

## Known traps

- `GitWorkflowService.remoteExists` does **not** pass `allowBare`, while `fetchRemote`,
  `resolveRemoteTrackingCommit` and `createWorktree` do. `planCoordinates` calls it first, so a bare
  `workspaceRoot` fails there — and as a `RetryableError`, i.e. it retries forever on a permanent
  condition.
- `worktreeBranchName` is `t3code/<8 hex>` (`buildTemporaryWorktreeBranchName`); the driver
  sanitizes `/` to `-` only for the directory name, not the ref.
- Branch cleanup is intentionally leaky: worktree removal keeps the branch
  (`WorktreeLifecycle.cleanupThreadWorktree` invariant), so "branch already exists" on retry is the
  expected case, not a corrupt state.
