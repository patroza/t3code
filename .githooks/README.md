# Native Git hooks

`pnpm install` configures `core.hooksPath=.githooks`. The tracked hooks exist
immediately in every linked worktree; `post-checkout` reconciles dependencies
after branch checkout and worktree creation before Git returns. T3 configures
the hook path and triggers that checkout once for a fresh clone, before exposing
the repository to the user.

Lefthook may later orchestrate parallel jobs, but is intentionally unused now.
