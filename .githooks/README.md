# Native Git hooks

`pnpm install` configures `core.hooksPath=.githooks`. The tracked hooks exist
immediately in every linked worktree; `post-checkout` reconciles dependencies
after branch checkout and worktree creation before Git returns. T3 configures
the hook path and triggers that checkout once for a fresh clone, before exposing
the repository to the user.

Successful reconciliation records the package/lockfile state under
`node_modules`, so T3's explicit handoff invocation does not repeat an install
which Git already completed. Explicit invocation from the target is required
for bare or stale source repositories.

Lefthook may later orchestrate parallel jobs, but is intentionally unused now.
