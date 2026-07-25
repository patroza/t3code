# Private fork workflow

This repository separates upstream history, private changes, temporary review branches, and the
runnable build:

```text
pingdotgg/t3code:main
    └── fork/tim                 selected Tim Smart PRs
            └── fork/candidates  selected open upstream PRs
                    └── fork/changes     our private changes
                            ├── ordinary feature PRs
                            ├── registered draft overlays
                            └── fork/integration   changes + overlays, tested/deployed
```

`main` mirrors `pingdotgg/t3code:main`. `fork/tim` is a linear provenance layer with one commit per
selected Tim Smart PR and a permanently open PR against `main`. `fork/candidates` is a temporary
upstream-provenance layer with one commit per selected open upstream PR and a permanently open PR
against `fork/tim`. `fork/changes` is the GitHub default branch and canonical private layer, with a
permanently open PR against `fork/candidates`.
`fork/integration` is generated from the reviewed layers plus registered integration overlays and
is used by running instances.

## Long-lived integration overlays

An upstreamable feature may remain as an open PR instead of being merged into `fork/changes`.
Register it under `integrationOverlays` in `.github/pr-stack.json`. Every overlay remains a
**parallel draft PR based on `fork/changes`**; overlays are never based on each other. The stack
workflow rebases overlays when `fork/changes` moves and composes their commits, in manifest order,
only in `fork/integration`.

Draft state is the merge lock. Normal Fork CI continues to run and can remain green, so health and
merge permission remain separate signals. A trusted workflow automatically returns managed PRs
(#1, #27, #2, and registered overlays) to draft if they are accidentally marked ready.

```sh
pnpm fork:stack overlay-add 10
pnpm fork:stack overlay-start 10 feature/deep-link-follow-up
pnpm fork:stack overlay-promote 10 upstream/desktop-deep-links
```

To change an overlay, commit directly to its branch or create a child PR with the overlay branch as
its base and merge the child into the overlay PR. Do not put the same change into `fork/changes`.
Landing an overlay is deliberate: remove its manifest entry in the same reviewed change that lands
the implementation in `fork/changes`, then verify that the resulting `fork/integration` tree is
unchanged.

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
and atomically updates `main`, `fork/tim`, `fork/candidates`, `fork/changes`, and
`fork/integration` with
force-with-lease. A repository-scoped write deploy key stored as `FORK_STACK_DEPLOY_KEY` is the only
automation actor allowed to bypass `main`'s PR and status-check requirements. It cannot access other
repositories. Never expose or reuse it.

Upstream's `.github/workflows/ci.yml` and `.github/workflows/deploy-relay.yml` remain present on the
exact `main` mirror but are disabled in this repository. Fork PR and integration checks use
`.github/workflows/fork-ci.yml`; the stack workflow dispatches that workflow for the exact generated
integration SHA. This avoids redundant CI and prevents an upstream-mirror update from being treated
as a fork product or relay deployment.

## Starting work

The helper starts an independent branch from `fork/changes`:

```sh
pnpm fork:stack start feature/my-change
```

Commit and push normally, then open the PR against `fork/changes` (never against `main`). Updating
that branch updates the same PR and reruns PR CI. Ordinary feature and import PRs are deliberately
not registered in the stack manifest, so multiple independent PRs may be open concurrently without
editing central metadata.

### Keeping feature PRs up to date

Feature branches drift when `fork/changes` moves (upstream mirror sync or merged siblings). Agents
must leave PRs mergeable at handoff:

```sh
# Current branch + its open PR
pnpm fork:stack update --push

# Explicit PR (checks out the head branch, updates, pushes)
pnpm fork:stack update --push 48

# Plan only (no push)
pnpm fork:stack update
```

`update` will:

1. fetch latest `origin/fork/changes` and the durable base-history ref
   (`refs/t3/stack/base-history/fork-changes`);
2. **rebase** when the branch already descends from the new tip but is behind;
3. when history diverged (normal after a stack rewrite): recover the **old base tip** this PR was
   built on — the newest recorded historical `fork/changes` tip that is still an ancestor of
   HEAD — then `git rebase --onto newBase oldBase`. Feature commits are exactly `oldBase..HEAD`
   (the commits that were on top of the old base), not a file-count guess and not the full GitHub
   PR commit list;
4. **retarget** the PR base to `fork/changes` if it still points at `main` or another wrong branch;
5. **force-with-lease push** when `--push` is set;
6. print `gh pr view` mergeability JSON.

The stack cascade records each `fork/changes` tip into that base-history ref before rebasing open
feature PRs the same way (`rebase --onto` from the recovered old base).

Do not use GitHub “Update branch” merge commits for these feature PRs; prefer this rebase/replay
path so history stays linear and reviewable.

When the stack workflow rewrites `fork/changes`, it also force-with-lease rebases every open feature
PR that targets `fork/changes` (conflicts are reported in the job summary and skipped). After that
remote rewrite, update your local checkouts with:

```sh
# On the feature branch (or fork/changes / any tracking branch)
pnpm fork:stack pull
```

`pull` fetches the remote tip and uses `git cherry` patch-ids:

- if every local commit is patch-equivalent to something already on the remote → **hard reset** to
  remote (safe when the only difference is a rewritten history you already pushed);
- if you have unique unpushed patches → **rebase** those onto the remote tip.

Require a clean working tree. This is the low-pain path after automation rebases open PRs.

After review, merge the PR into `fork/changes`. That push automatically runs the stack synchronizer:

```sh
feature PR merged into fork/changes
    → rebase-pr-stack workflow
    → fork/integration updated atomically
    → CI dispatched for the exact integration SHA
    → successful CI classifies the tree diff
        → runtime-affecting changes trigger fleet deployment
        → test, documentation, and automation-only changes stop after CI
```

Deployment classification compares complete tested integration trees rather than only the latest
commit. Unknown paths are runtime-affecting by default. This preserves safe deployment when a PR
contains mixed changes or a new source directory appears, while avoiding fleet rebuilds and mobile
OTA updates for tests, snapshots, documentation, agent instructions, and GitHub-only metadata.

Runtime-affecting integrations also publish both mobile release tracks from the exact tested SHA.
Both tracks use Expo Fingerprint: they publish an OTA update when a compatible build already
exists, and start a new build when native runtime inputs changed. A new production build is
submitted to TestFlight automatically, so an installed tester build stays current without a manual
dispatch. Manual runs of `Mobile EAS Production` can still force `build` or `update`; manual runs of
`Mobile EAS Development` may target iOS, Android, or both. Automatic integration publishing targets
iOS, because Android has no signing keystore configured.

The manifest contains the permanent `fork/tim`, `fork/candidates`, and `fork/changes` PRs. The
synchronizer rebases that provenance chain onto the latest upstream `main` and rebuilds
`fork/integration`. Other open repository PRs are ignored. Temporary state is retained after a
conflict and can be resumed with the command printed in the error.

`register` is used during the one-time cutover and only when intentionally building an advanced,
dependent integration chain:

```sh
pnpm fork:stack register 201
```

The permanent `fork/tim`, `fork/candidates`, and `fork/changes` PRs are never merged while this
model is active.

### Multiple features

Independent changes use parallel branches and PRs, all based on `fork/changes`. They can be reviewed
and merged in any order; run `pnpm fork:stack update --push` on a remaining branch if an earlier
merge overlaps it or the PR becomes CONFLICTING.

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

## Running open upstream candidates

An upstream PR may be production-worthy before `pingdotgg/t3code` accepts it. Import it from
`fork/candidates`, never from `main`, `fork/tim`, or `fork/changes`:

```sh
git fetch origin fork/candidates
git fetch upstream refs/pull/<number>/head:refs/remotes/upstream/pr/<number>
git switch -c import/upstream-pr-<number> origin/fork/candidates
git cherry-pick --no-commit upstream/pr/<number>
# retain only the reviewed source PR behavior, update .github/upstream-candidates.json,
# test, commit once, push, and open against fork/candidates
```

Each candidate PR must become exactly one provenance commit and document the upstream PR URL,
source SHA, imported behavior, local adaptations, and exclusions. The registry
`.github/upstream-candidates.json` records the same source SHA and lifecycle state. Product-specific
follow-ups belong in `fork/changes`, not in the candidate commit.

Before updating the upstream mirror, inspect every active candidate:

- unchanged and open: retain it;
- updated upstream: review and replace its provenance commit through a new candidate PR;
- merged with equivalent behavior: remove the candidate commit while rebasing the layer;
- merged differently or closed: stop automatic synchronization and reconcile deliberately.

After reconciliation, compare the old and rebuilt `fork/integration` trees. Removing an accepted
candidate must not remove adaptations that belong to `fork/changes`.

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
`fork/changes`; earlier permanent layers describe provenance such as `fork/tim` and
`fork/candidates`. Add another layer only when it has durable ownership and update the manifest, PR
bases, and documentation together.

## Provenance rebuild archive

The pre-provenance woven graph is preserved locally and remotely at:

- `archive/fork-changes-woven-2026-07-24`
- `archive/fork-integration-woven-2026-07-24`
- matching annotated tags prefixed with `archive-`

The clean rebuild preserves the exact archived `fork/changes` tree while replacing its ancestry
with `main → fork/tim → fork/candidates → fork/changes`. Never delete or force-update the archive
refs.
