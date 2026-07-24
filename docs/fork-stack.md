# Private fork workflow

This repository separates upstream history, private changes, temporary review branches, and the
runnable build:

```text
pingdotgg/t3code:main
    └── fork/tim                 selected Tim Smart PRs
            └── fork/changes     our private changes
                    ├── feature PRs
                    └── fork/integration   tested and deployed tip
```

`main` mirrors `pingdotgg/t3code:main`. `fork/tim` is a linear provenance layer with one commit per
selected Tim Smart PR and a permanently open PR against `main`. `fork/changes` is the GitHub default
branch and canonical private layer, with a permanently open PR against `fork/tim`.
`fork/integration` is generated from both reviewed layers and is used by running instances.

## Updating from upstream

Do not use GitHub's **Sync fork** button, create a PR into this repository's `main`, or push `main`
manually. A GitHub PR merge would rewrite upstream commits, while an ordinary push is correctly
blocked by the `Protect upstream main` ruleset.

The `Rebase fork PR stack` workflow is the sole synchronization path. It runs every six hours and
can also be started with:

```sh
gh workflow run rebase-pr-stack.yml --repo patroza/t3code --ref fork/changes
```

The workflow fetches `pingdotgg/t3code:main`, verifies that the existing mirror has not diverged,
and atomically updates `main`, `fork/tim`, `fork/changes`, and `fork/integration` with
force-with-lease. A repository-scoped write deploy key stored as `FORK_STACK_DEPLOY_KEY` is the only
automation actor allowed to bypass `main`'s PR and status-check requirements. It cannot access other
repositories. Never expose or reuse it.

## Starting work

The helper starts an independent branch from `fork/changes`:

```sh
pnpm fork:stack start feature/my-change
```

Commit and push normally, then open the PR against `fork/changes`. Updating that branch updates the
same PR and reruns PR CI. Ordinary feature and import PRs are deliberately not registered in the
stack manifest, so multiple independent PRs may be open concurrently without editing central
metadata.

After review, merge the PR into `fork/changes`. That push automatically runs the stack synchronizer:

```sh
feature PR merged into fork/changes
    → rebase-pr-stack workflow
    → fork/integration updated atomically
    → CI dispatched for the exact integration SHA
    → successful CI triggers fleet deployment
```

The manifest contains the permanent `fork/tim` PR followed by the permanent `fork/changes` PR. The
synchronizer rebases that provenance chain onto the latest upstream `main` and rebuilds
`fork/integration`. Other open repository PRs are ignored. Temporary state is retained after a
conflict and can be resumed with the command printed in the error.

`register` is used during the one-time cutover and only when intentionally building an advanced,
dependent integration chain:

```sh
pnpm fork:stack register 201
```

The permanent `fork/tim` and `fork/changes` PRs are never merged while this model is active.

### Multiple features

Independent changes use parallel branches and PRs, all based on `fork/changes`. They can be reviewed
and merged in any order; rebase a remaining branch if an earlier merge overlaps it.

Related changes may use one cohesive PR. If separate review is valuable, chain only those PRs by
basing the dependent PR on the preceding feature branch. Merge the chain from bottom to top into
`fork/changes`. Do not place unrelated features in one dependency chain.

Use the PR title, branch name, affected-area field in the PR template, and GitHub's open/merged PR
history to find prior work. Agents must check `gh pr status` and verify a PR's state before deciding
whether to update its branch or create a new PR.

Search by feature words instead of remembering PR numbers:

```sh
pnpm fork:stack find "board pagination"
pnpm fork:stack find-upstream "worktree cleanup"
```

## Importing another fork

External forks are source remotes, not branches to merge wholesale. For Tim Smart, start an import
branch from `fork/tim`, port only the wanted source PR, and open it against `fork/tim`:

```sh
git fetch tim
git switch -c import/tim-pr-17 origin/fork/tim
git cherry-pick <unchanged-commit>
git cherry-pick --no-commit <commit-to-adapt>
# keep Tim's imported behavior in one commit; test and open against fork/tim
```

Do not merge an external branch wholesale. For every import PR, document:

- imported unchanged;
- adapted to local behavior;
- intentionally excluded;
- provenance using fully qualified links such as `tim-smart/t3code#17`.

Merge the import with squash so `fork/tim` gains exactly one provenance commit. Adjustments for our
environment use a separate normal PR against `fork/changes`; never hide private policy inside the
Tim layer. A later Tim update is compared against both the prior provenance commit and our
adjustment, and automation never overwrites local decisions.

## Upstreamable changes

Every feature lands in `fork/changes`; upstreamability is a clean projection, not an alternative
home. Closing or rejecting an upstream PR therefore never removes the private implementation.

After the private PR merges, promote it onto real upstream history:

```sh
pnpm fork:stack promote <private-pr-number> upstream/portable-feature
# remove private assumptions from the staged extraction, test, and commit
```

The command creates a branch from upstream `main` and stages the private PR's commits without
committing, allowing the projection to be simplified before opening it to `pingdotgg/t3code:main`:

```sh
gh pr create \
  --repo pingdotgg/t3code \
  --base main \
  --head patroza:upstream/portable-feature
```

For work that began upstream-first, adopt its clean branch into the private fork:

```sh
pnpm fork:stack adopt upstream/portable-feature adopt/portable-feature
# push and open adopt/portable-feature against fork/changes
```

If the upstream proposal is withdrawn, demotion closes only the projection and cross-links the
private source:

```sh
pnpm fork:stack demote <upstream-pr-number> <private-pr-number>
```

Never rebase the private branch onto `main`. Promotion creates an independently reviewable upstream
implementation while `fork/changes` remains canonical. Select `main` in T3, or use
`start-upstream`, only for deliberately upstream-first work.

## Splitting the consolidated fork

The registered chain is ordered from upstream toward deployment. Its final PR must always use
`fork/changes`; earlier permanent layers describe provenance such as `fork/tim`. Add another layer
only when it has durable ownership and update the manifest, PR bases, and documentation together.

## Provenance rebuild archive

The pre-provenance woven graph is preserved locally and remotely at:

- `archive/fork-changes-woven-2026-07-24`
- `archive/fork-integration-woven-2026-07-24`
- matching annotated tags prefixed with `archive-`

The clean rebuild preserves the exact archived `fork/changes` tree while replacing its ancestry
with `main → fork/tim → fork/changes`. Never delete or force-update the archive refs.
