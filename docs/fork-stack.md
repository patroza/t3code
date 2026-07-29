# Downstream fork workflow

This repository separates upstream history, downstream changes, temporary review branches, and the
runnable build:

```text
pingdotgg/t3code:main
    └── fork/tim                 selected Tim Smart PRs
            └── fork/candidates  selected open upstream PRs
                    └── fork/changes     our downstream changes
                            ├── ordinary feature PRs
                            ├── registered draft overlays
                            └── fork/integration   changes + overlays, tested/deployed
```

`main` mirrors `pingdotgg/t3code:main`. `fork/tim` is a linear provenance layer with one commit per
selected Tim Smart PR and a permanently open PR against `main`. `fork/candidates` is a temporary
upstream-provenance layer with one commit per selected open upstream PR and a permanently open PR
against `fork/tim`. `fork/changes` is the GitHub default branch and canonical downstream layer, with a
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
When `fork/changes` rewrites, stack automation rebases the overlay first and then recursively rebases
its child and descendant PRs onto their rewritten parents. A conflict blocks only that PR's subtree.
Landing an overlay is deliberate: remove its manifest entry in the same reviewed change that lands
the implementation in `fork/changes`, then verify that the resulting `fork/integration` tree is
unchanged.

Some overlays also own complete client integrations. Their path ownership and change-routing rules
live in [client-overlays.md](./client-overlays.md). Check that ownership before starting ordinary
work so Discord, VS Code, and desktop-link changes do not accidentally leak back into
`fork/changes`.

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
force-with-lease. A repository-scoped write deploy key stored as `FORK_STACK_DEPLOY_KEY` is the
automation actor that bypasses branch rulesets for those force-with-lease updates (including
`main`'s PR and status-check requirements). It cannot access other repositories. Never expose or
reuse it.

## Branch rulesets (protection vs rewrites)

Repository rulesets gate **long-lived stack branches**. Ordinary feature branches (`feat/**`,
`import/**`, …) are not covered, so agents and humans can still force-push them freely.

| Ruleset                                   | Branches                                          | Enforced                                                                                                                                                  | Bypass (always)                                                                                |
| ----------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Protect upstream main                     | `main`                                            | No delete, no force-push, linear history, **PR required**, **Fork CI checks**                                                                             | `patroza`, `omegabot`, deploy key (`FORK_STACK_DEPLOY_KEY`); Admin role may bypass via PR only |
| Protect fork/changes (PR + CI)            | `fork/changes`                                    | No delete, no force-push, linear history, **PR required** (squash/rebase), **strict Fork CI** (Check, Test, Mobile Native Static Analysis, Release Smoke) | `patroza`, `omegabot`, deploy key                                                              |
| Protect fork/tim, candidates, integration | `fork/tim`, `fork/candidates`, `fork/integration` | No delete, no force-push, linear history (no PR requirement — stack rebuilds these tips)                                                                  | `patroza`, `omegabot`, deploy key                                                              |

**CI path:** the stack workflow authenticates with the deploy key, not `GITHUB_TOKEN` (default
workflow token is read-only and cannot be added as an Integration bypass on this personal fork).

**Who cannot force-push protected branches:** write collaborators without a User bypass entry.
They can still open PRs into `fork/changes` and merge only when required checks are green.

**Who can force-push:** `patroza`, `omegabot` (must accept the collaborator invite), and the stack
deploy key. Feature-branch force-pushes do not need bypass.

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

Feature branches drift when their parent moves (`fork/changes` for ordinary features, or another
feature/overlay branch for dependent PRs). Agents must leave PRs mergeable at handoff:

```sh
# Current branch + its open PR
pnpm fork:stack update --push

# Explicit PR (checks out the head branch, updates, pushes)
pnpm fork:stack update --push 48

# Plan only (no push)
pnpm fork:stack update
```

`update` will:

1. resolve and fetch the PR's intended parent branch;
2. **rebase** when the branch already descends from the new tip but is behind;
3. when history diverged (normal after a stack rewrite), recover the **old parent tip** this PR was
   built on—from the durable `fork/changes` history or the parent PR's force-push history—then run
   `git rebase --onto newParent oldParent`. The replay contains only this PR's commits;
4. preserve intentional dependent/overlay-child bases and retarget only invalid bases;
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

### Lockfile after layer rewrites (agents and humans)

Stack and manual recoveries often hit conflicts in `pnpm-lock.yaml` (and sometimes `patches/*`) when
upstream or Tim changes dependencies while a large `fork/changes` commit also touches manifests.

**Do not** finish a recovery by only checking out `--ours` or `--theirs` for the lockfile if any
`package.json` still disagrees with it. Fork CI installs with a **frozen** lockfile; a mismatch
fails every job at `Setup Vite+` with `ERR_PNPM_OUTDATED_LOCKFILE` (for example after
`packages/client-runtime` gained `react` / `@types/react` while the lockfile was left on the
rebased base).

Required recovery step after resolving stack conflicts that touch package manifests or the lockfile:

```sh
# On the tip you are about to push as fork/changes (or a fix PR based on it)
CI= pnpm install --no-frozen-lockfile
git add pnpm-lock.yaml
# commit, open/merge PR to fork/changes if the rewrite already landed without this
# then recompose integration and re-dispatch Fork CI
node scripts/compose-integration-overlays.ts   # when integration tip must pick up the fix
gh workflow run fork-ci.yml --repo patroza/t3code --ref fork/integration
```

Prefer one deliberate lockfile regeneration at the end of a multi-commit `fork/changes` rebase over
resolving the lockfile at every intermediate conflict.

### Conflict resolutions (`.github/pr-stack.json`)

Protected stack rebases stop on the first unresolved conflict unless the path is listed under
`conflictResolutions`. **Resuming once without updating the manifest leaves a bomb for the next
upstream sync** — exact commit SHAs change every time a layer is rewritten.

Each entry:

| Field      | Meaning                                                                                                        |
| ---------- | -------------------------------------------------------------------------------------------------------------- |
| `branch`   | Layer being rebased (`fork/tim`, `fork/candidates`, `fork/changes`, or an overlay branch)                      |
| `commit`   | Full 40-char SHA of the commit being replayed (`REBASE_HEAD`), **or** `"*"` for any commit on that branch+path |
| `path`     | Repo-relative conflicted file                                                                                  |
| `strategy` | `theirs` = take the commit being replayed; `ours` = keep the new base (rebase semantics)                       |

Prefer **`commit: "*"`** for known permanent policies (e.g. always take the mobile feed from the
downstream commit). Use a full SHA only for a one-shot resume of the current replay.

Required workflow when automation stops on a conflict:

1. Note branch, `REBASE_HEAD` SHA, subject, and conflicted paths from the job summary / logs.
2. Decide `ours` vs `theirs` (or a hand-merged tree) for each path.
3. **Append** matching `conflictResolutions` entries to `.github/pr-stack.json` (durable `*` when
   the same path will keep that side on future rebases).
4. Open/merge a PR to `fork/changes` with that manifest update **before** calling the stack “done”.
5. Resolve/stage files and `node scripts/rebase-pr-stack.ts resume --state <dir> --push`, **or**
   re-run `sync --push` after the manifest is on the tip the sync reads.
6. Run **per-layer full CI** (below). Lockfile conflicts still need
   `CI= pnpm install --no-frozen-lockfile` — never leave a mismatched lock as the “resolution”.

The stack conflict summary prints ready-to-paste JSON for both `*` and exact-SHA forms.

### Product conflicts (shared UI / app code — never blind whole-file)

`conflictResolutions` with whole-file `ours`/`theirs` is appropriate for **fork-owned** paths and
boilerplate (`pnpm-lock.yaml`, pure fork-only modules). It is **not** safe for shared product files
where both the new base and the replayed commit carry real behavior (classic example:
`apps/web/src/components/chat/ChatHeader.tsx` — recovery once kept
`resolveRemoteVscodeOpenTarget` + unit tests and **dropped the remote Open in VS Code header
button**, so CI stayed green while the control vanished; restored in #154).

**Never register durable `*` whole-file policies** on:

- `apps/server/src/**`, `apps/web/src/**`, `apps/mobile/src/**`, client overlays under `apps/*/`
- `packages/client-runtime/src/**`, `packages/contracts/src/**`, `packages/shared/src/**`

Especially VCS clusters (`GitVcsDriverCore*`, `vcs.ts` / `vcsAction*`, BranchToolbar, CommandPalette,
`ws.ts`): taking main or Tim whole-file once produced tip-only `fix(stack)` patches (#165/#166).
Those patches are debt — fold them into the **related provenance/feature commit** on the next
rewrite (see [stack-history-rewrite.md](./stack-history-rewrite.md)).

When a conflict touches `apps/**` or `packages/**` product code:

1. **Do not** apply a durable whole-file `*` policy unless the path is documented as always taking
   one side for every rewrite (and is **not** product code above).
2. **3-way merge or re-apply** the known-good feature commit after a clean base; do not invent a
   partial hand merge that keeps helpers/tests and drops JSX / wiring.
3. **Parity check** before resume/push: `git diff` the pre-rewrite tip vs the resolved path; if a
   symbol remains only in tests (or pure helpers) while the product surface is gone, the resolution
   is incomplete.
4. **Tests that would have failed #154:** every fork product change needs an existence or behavior
   assertion for the surface users see — pure URI/helper tests alone are insufficient. Prefer:
   - exported pure gates (`shouldOfferRemoteVscodeOpen`, list defaults, …), **and**
   - one existence check (`aria-label` / `data-testid` via `renderToStaticMarkup`, or source markers
     in `apps/web/src/forkSurfaceExistence.test.ts` for chrome that is hard to mount).
5. After resolving, run the focused tests for the conflicted package **and** the root pre-push gate
   for the layer (see AGENTS.md). Prefer
   `node scripts/rebase-pr-stack.ts sync --dry-run --verify-each-commit` (or `--push`) so **each
   replayed commit** typechecks before the next lands.

### Commit-green during stack rewrite (not tip-only)

**Layer tip green is necessary; it is not sufficient.** Tip-only `fix(stack): rejoin …` commits hide
broken intermediate SHAs and reappear after the next rebase.

Two bars:

| When                                    | Gate                                      |
| --------------------------------------- | ----------------------------------------- |
| **Each layer tip** after rewrite        | Full local Fork CI (below)                |
| **Each replayed commit** during rewrite | Typecheck packages touched by that commit |

Enable per-commit typecheck:

```bash
CI= pnpm install --no-frozen-lockfile   # once in the tree that supplies node_modules
node scripts/rebase-pr-stack.ts sync --dry-run --verify-each-commit
# or
node scripts/rebase-pr-stack.ts sync --push --verify-each-commit
```

Implementation: `git rebase --exec 'node scripts/rebase-pr-stack.ts verify-head'` after every pick.
`verify-head` maps `HEAD^..HEAD` paths to pnpm filters and runs each package's `typecheck`. Config /
docs / lock-only commits skip package typecheck.

**On failure:** stop. Fix the **replayed commit** (conflict resolution or provenance content), not a
new tip patch. Product recovery belongs **inside** Tim/candidate/feature commits, never as a
standalone `fix(stack)` product commit on `fork/changes`.

Allowed under `fix(stack)` / `feat(fork-stack)` naming:

- stack automation (`scripts/rebase-pr-stack.ts`, compose, CI wiring)
- durable **non-product** `conflictResolutions` (manifest paths, lockfile strategy)
- docs for the stack itself

Not allowed as permanent history:

- re-applying dropped UI/VCS/API after a blind resolve
- “make typecheck green” tips that only undo a bad `ours`/`theirs`

History cleanup procedure: [stack-history-rewrite.md](./stack-history-rewrite.md).

### Integration overlay compose and lockfiles

`node scripts/compose-integration-overlays.ts` rebuilds `fork/integration` by cherry-picking each
overlay's commits onto current `fork/changes`. Overlay lockfiles **intentionally diverge** (each
overlay only needs its own workspace package). Compose therefore:

1. **Skips** commits that only touch `pnpm-lock.yaml`.
2. On a mixed commit that conflicts **only** on `pnpm-lock.yaml`, keeps the current lock (`--ours`)
   and continues the product files from the overlay.
3. **Seeds `node_modules`** before install when a warm tree is available (see below).
4. **Regenerates** a single integration lockfile with
   `pnpm install --no-frozen-lockfile --prefer-offline` (proxy env stripped) and commits it.

Do not treat overlay lockfile commits as product truth for integration. Do not leave a partial
compose tip pushed after a lockfile conflict — finish compose (or re-run the script) so the
regenerated lock is on `fork/integration`.

#### Warm `node_modules` seed (`cp --reflink=auto`)

Cold `pnpm install` in a temp compose clone is multi‑minute (or hung if the agent session still
inherits a SOCKS proxy). Compose therefore:

1. Puts the compose worktree under **`~/.t3/compose-work/`** (btrfs home), **not** `/tmp` (often
   tmpfs — reflink cannot share extents with `/home`).
2. **Clones** an existing `node_modules` with `cp -a --reflink=auto` from, in order:
   - `COMPOSE_NODE_MODULES_SOURCE` (if set)
   - `<sourceRoot>/node_modules` (the checkout running the script)
   - sibling / `~/pj/t3code` / `~/deploy/t3code` warm trees
3. Runs install against that seed so resolution is mostly offline and fast.

On btrfs/xfs same-filesystem copies this is CoW (seconds for multi‑GB trees). On other FS it falls
back to a full copy. Optional: `COMPOSE_WORK_ROOT` overrides the work directory parent.

### Per-layer full CI after stack rebase (required — stop the line)

When you manually rebase or rewrite the stack, **do not advance to the next layer until the current
layer passes the full local CI gate** (not only `vp check`). A red parent must never receive more
layers on top of it. Prefer `--verify-each-commit` during the rewrite so intermediate SHAs are also
typecheck-green (see **Commit-green during stack rewrite** above).

After each layer is rebased onto its parent, install/lock is consistent, and conflicts are resolved
(and `conflictResolutions` updated when you hand-resolved):

1. Check out that layer’s tip.
2. Run the **full local Fork CI gate** on that tip:
   - `vp check`
   - `ELECTRON_SKIP_BINARY_DOWNLOAD=1 vp run -r --cache --log labeled typecheck`
   - `vp run --cache build:desktop` + preload verify steps from `.github/workflows/fork-ci.yml`
   - `ELECTRON_SKIP_BINARY_DOWNLOAD=1 vp run test` (**required per stack layer**)
   - On macOS when applicable: mobile native lint / Open With pieces from Fork CI
   - `node scripts/release-smoke.ts` when release/packaging paths may have changed
3. Fix **every** failure on **that layer**. Commit and force-with-lease push the layer if needed.
4. **Only then** rebase, replay, or compose the **next** layer onto the fixed parent.

Layer order for this gate:

```text
main (upstream mirror — skip product fixes; do not hand-edit)
  → fork/tim
  → fork/candidates
  → fork/changes
  → each integration overlay (desktop, discord, vscode) onto fork/changes
  → fork/integration (compose last; full CI on the composed tip)
```

Skipping CI on a layer and stacking “fix it later” commits is how lockfile, typecheck, and test
failures cascade into every PR and block merge. **One red layer stops the rewrite.** Feature PRs
(e.g. based on `fork/changes`) after `pnpm fork:stack update`: rebase onto the fixed parent, then
run the mandatory pre-push gate (and full tests when rewriting stack layers themselves) before
push/merge. Agent-facing requirements: [AGENTS.md](../AGENTS.md) (“Per-layer stack CI”).

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
environment use a separate normal PR against `fork/changes`; never hide downstream policy inside the
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
home. Closing or rejecting an upstream PR therefore never removes the downstream implementation.

After the downstream PR merges, promote it onto real upstream history:

```sh
pnpm fork:stack promote <downstream-pr-number> upstream/portable-feature
# remove downstream-only assumptions from the staged extraction, test, and commit
```

The command creates a branch from upstream `main` and stages the downstream PR's commits without
committing, allowing the projection to be simplified before opening it to `pingdotgg/t3code:main`:

```sh
gh pr create \
  --repo pingdotgg/t3code \
  --base main \
  --head patroza:upstream/portable-feature
```

For work that began upstream-first, adopt its clean branch into the downstream fork:

```sh
pnpm fork:stack adopt upstream/portable-feature adopt/portable-feature
# push and open adopt/portable-feature against fork/changes
```

If the upstream proposal is withdrawn, demotion closes only the projection and cross-links the
downstream source:

```sh
pnpm fork:stack demote <upstream-pr-number> <downstream-pr-number>
```

Never rebase the downstream branch onto `main`. Promotion creates an independently reviewable upstream
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
