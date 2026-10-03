# Native Git hooks

`pnpm install` configures `core.hooksPath=.githooks`. The tracked hooks exist
immediately in every linked worktree; `post-checkout` reconciles dependencies
after branch checkout and worktree creation before Git returns. T3 configures
the hook path and triggers that checkout once for a fresh clone, before exposing
the repository to the user.

## `post-checkout`

### 1. Clear TypeScript project emit (always on branch / worktree checkout)

Composite packages and build outputs leave gitignored `dist/` and
`*.tsbuildinfo`. After a branch switch those artifacts can still belong to
another tree while sources follow HEAD. That produces phantom type errors (or
stale emit consumers) that disappear after a clean rebuild — same class of
failure as [scanner#1495](https://github.com/macs-holding/scanner/pull/1495) /
[scanner#2166](https://github.com/macs-holding/scanner/pull/2166) and upstream
typescript-go incremental gaps.

On every **branch** checkout (flag `1`), this hook deletes:

- `apps/*/dist` **except** `apps/server/dist` (live-served SPA + `bin.mjs`; wiping
  it 503s any process still serving from this checkout), `apps/*/dist-electron`,
  `packages/*/dist`
- any remaining `*.tsbuildinfo` outside `node_modules` / `.git` / `.vite-plus`

File-only checkouts (flag `0`) are left alone.

**This is a workaround.** Remove when TypeScript/tsgo incremental invalidation
is reliable ([typescript-go#2666](https://github.com/microsoft/typescript-go/issues/2666),
[#4664](https://github.com/microsoft/typescript-go/issues/4664),
[#4262](https://github.com/microsoft/typescript-go/issues/4262)). Do not
re-enable cross-tree dist reuse without an exact source-identity key.

### 2. Seed copy + pnpm install

Successful reconciliation records the package/lockfile state under
`node_modules`, so T3's explicit handoff invocation does not repeat an install
which Git already completed. Explicit invocation from the target is required
for bare or stale source repositories.

When T3 will launch a configured worktree setup script, its VCS driver sets
`T3CODE_DEFER_DEPENDENCY_INSTALL=1`. The hook still clears stale emit and copies
seed files, but skips `pnpm install` so setup can perform it asynchronously in
the thread terminal. Raw Git worktree creation does not set this marker and
continues to return with dependencies prepared.

Lefthook may later orchestrate parallel jobs, but is intentionally unused now.
