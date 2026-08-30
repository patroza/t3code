2. No reentrancy checks. There's no fs.exists(worktreePath) skip and no branch-exists fallback, so any retry after a partial run hits "path already exists" / "branch already exists", which you map to RetryableError → infinite retry loop. This is the checklist part of the design; it's currently a straight-line transaction.
3. The rollback we agreed to drop is back (Effect.onError → removeWorktree, lines 408-416). It fires on retryable dispatch failures too, throwing away the checkout the next pass would have reused. Delete only on fatal abandonment.
4. Setup-script failure is RetryableError (lines 420-432). We said log-and-continue — and as written the error is worse than useless: thread.create already succeeded, so the next reconcile pass sees the thread present and never calls provisionThread again. The scripts won't re-run; the error just wastes a pass. Swallow with a logWarning like the old processor did.
5. deferDependencyInstall: true is missing. Without it the post-checkout hook installs dependencies inside createWorktree, then your setup scripts install again.

# 2

1. Derive the expected location from live state: worktreePath from worktreesDir + repo name + worktreeBranchName.
2. Inspect what's at the path. Ask git, not the filesystem: is this directory a registered worktree of the project repo, with HEAD on worktreeBranchName? If yes — the step is already done; reuse it and stop.
3. If the path is occupied by anything else — partial checkout, wrong branch, not a worktree at all — destroy it. The path is namespaced by this exchange's UUID-derived branch, so whatever is there is this exchange's own debris, never someone else's work. Remove with force (fall back to plain directory deletion if git doesn't even recognize it).
4. Clear stale worktree registration. A crash can leave the repo remembering a worktree whose directory is gone (.git/worktrees/<name> entry without a checkout); git refuses to re-add at that path until it's pruned. Prune before creating.
5. Branch on whether worktreeBranchName exists in the repo.
   - Exists — a prior attempt already created it; adopt it: add the worktree checking out that branch (no branch creation). Its tip is wherever the crash left it, which by construction is startCommitSha.
   - Doesn't exist — first real attempt: create the branch at startCommitSha, record startBranchName as its merge base, defer dependency install to the setup-script step.
6. Postcondition — same predicate as step 2: path is a registered worktree on worktreeBranchName. Anything short of that is a failure of this attempt, left in place for the next pass to re-enter at step 1 (fatal-vs-retryable classification is a separate concern).
