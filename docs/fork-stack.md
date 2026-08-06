# Downstream fork workflow

> [!IMPORTANT]
> **Superseded. Do not follow this for new work.**
>
> Contributors branch from and target **`fork/dev`** — every kind of work, including Discord, VS Code,
> identity and desktop. The integration overlays are drained and deregistered, and `fork/changes` and
> `fork/integration` are frozen. See
> [stable-dev-release-branch-handover.md](./stable-dev-release-branch-handover.md).
>
> Kept as a record of how the fork operated before 2026-08-06, and because the provenance stack
> (`main` → `fork/base` → `fork/tim` → `fork/candidates`) it describes is still current.

This repository separates upstream history, downstream changes, temporary review branches, and the
runnable build:

```text
pingdotgg/t3code:main
    └── fork/base                fork-only repo plumbing (CI runners, Fork CI workflow)
            └── fork/tim         selected Tim Smart PRs
                    └── fork/candidates  selected open upstream PRs
                            └── fork/changes     our downstream changes
                                    ├── ordinary feature PRs
                                    ├── registered draft overlays
                                    └── fork/integration   changes + overlays, tested/deployed
```

`main` mirrors `pingdotgg/t3code:main`.

**`fork/base`** sits on `main` and holds **only** adaptations this fork needs for GitHub Actions and
repo automation (for example GitHub-hosted `fork-ci.yml` and Blacksmith-free `ci.yml` runner labels).
No Tim imports, no candidates, no product. Permanent draft PR against `main`. See
[fork-base.md](./fork-base.md).

`fork/tim` is a linear provenance layer with one commit per selected Tim Smart PR and a permanently
open PR against **`fork/base`** (not bare `main`). `fork/candidates` is a temporary
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
(#1, #27, #2, and registered overlays) to draft if they are accidentally marked ready. Permanent
overlay drafts **must** carry the GitHub label **`OVERLAY`**.

```sh
pnpm fork:stack overlay-add 10
pnpm fork:stack overlay-start 10 feature/deep-link-follow-up
pnpm fork:stack overlay-promote 10 upstream/desktop-deep-links
```

### Permanent draft PRs — reopen first, do not mint replacements

Managed stack PRs (`fork/base`, `fork/tim`, `fork/candidates`, `fork/changes`) and every registered
**`integrationOverlays`** PR are long-lived identity. If one is **accidentally closed** (or stuck
closed after a tip rewrite):

1. **Fix the branch first** — rebase onto the intended base (`fork/changes` for overlays; layer
   parent for managed stack PRs), resolve product conflicts properly, force-with-lease the tip.
2. **Reopen the same PR number** — `gh pr reopen <n>`, ensure it is **draft**, and for overlays
   ensure label **`OVERLAY`**.
3. **Only if reopen fails** (GitHub refuses, or the head/base relationship is irrecoverable): open a
   **new** draft PR for the same branch, apply **`OVERLAY`**, and update
   `.github/pr-stack.json` → `integrationOverlays[].number` in the **same** change that introduces
   the new number. Do not leave the manifest pointing at a closed PR.

Do **not** open a fresh overlay PR as the default recovery path; PR number churn breaks stack
validation and review continuity.

### Fixing layer tips — prefer amend / rewrite

When repairing **`fork/changes`** or a **registered overlay tip** (format, typecheck, accidental
strip from reapply, compose-policy docs, etc.) and you have stack push bypass:

- Prefer **`git commit --amend`** or a small history rewrite that folds the fix into the **commit
  that introduced the problem** (or into the existing product / reapply commit on that tip).
- Force-with-lease the layer tip; rebase children/overlays as needed.
- **Avoid** permanent tip-only recovery commits (`style(docs):…`, `fix(stack):…`, drive-by format
  tips) on shared stack branches when rewrite is allowed — they accumulate noise and still require
  the next restack to fold them.

Ordinary **feature** work still lands as new commits via PRs that **merge** into the layer. Amend
is for **maintaining** the layer tip itself, not for rewriting already-merged public feature history
on someone else's open PR without coordination.

To change an overlay's product, commit directly to its branch (amend when fixing that tip) or create
a child PR with the overlay branch as its base and merge the child into the overlay PR. Do not put
the same change into `fork/changes`.
**Merging** a child PR into a registered overlay base (or into `fork/changes`) triggers **Compose
fork integration**, so `fork/integration` picks up the new tip once overlays are based on current
`fork/changes`. Plain **pushes** / force-pushes do **not** compose — that keeps permanent draft PR
status limited to Fork CI (Check/Test/…) and keeps rebase storms manual.
When `fork/changes` rewrites without a merge event, rebase overlays and compose with
`workflow_dispatch` (or local scripts). Landing an overlay into shared product is deliberate: remove
its manifest entry in the same reviewed change that lands the implementation in `fork/changes`, drop
its branch from `compose-integration.yml` / `fork-ci.yml` base lists, then verify that the resulting
`fork/integration` tree is unchanged.

Some overlays also own complete client integrations. Their path ownership and change-routing rules
live in [client-overlays.md](./client-overlays.md). Check that ownership before starting ordinary
work so Discord, VS Code, and desktop-link changes do not accidentally leak back into
`fork/changes`.

## Updating from upstream

Do not use GitHub's **Sync fork** button, create a PR into this repository's `main`, or push `main`
manually. A GitHub PR merge would rewrite upstream commits, while an ordinary push is correctly
blocked by the `Protect upstream main` ruleset.

### Fast path — compose `fork/integration` after product or overlay **merges**

Day-to-day merges do **not** run a full layer restack. Workflow **Compose fork integration**
(`.github/workflows/compose-integration.yml`) rebuilds `fork/integration` and dispatches Fork CI
**only** when:

- a PR is **merged** into **`fork/changes`**, or
- a PR is **merged** into a **registered overlay base** (child PR into desktop/discord/vscode/
  identity), or
- it is started manually (`workflow_dispatch`):

```sh
gh workflow run compose-integration.yml --repo patroza/t3code --ref fork/changes
```

It does **not** run on branch **pushes** (including overlay auto-rebase force-with-lease and agent
deploy-key tip rewrites). Permanent layer draft PRs must not show compose as a failing/required
check — only Fork CI jobs gate those PRs.

Before compose, the workflow runs `node scripts/rebase-integration-overlays.ts` so registered
overlay tips are force-with-lease rebased onto current `fork/changes` when they lag (no-op when
already based). Clean **merges** to `fork/changes` should no longer require a human to rebase every
overlay first. Conflicts still fail the job with the overlay branch and paths. Overlay branch names
in the workflow `on.pull_request` base list must stay aligned with `.github/pr-stack.json` →
`integrationOverlays`.

### Tim / candidates CI (via `fork/base`, no Blacksmith)

Upstream `main` ships `.github/workflows/ci.yml` with **Blacksmith** runner labels. This fork has
no Blacksmith capacity. **`fork/base`** rewrites those labels to GitHub-hosted runners and adds
`fork-ci.yml`, so every layer above base inherits working CI files.

**Required:** keep the repository workflow **CI** disabled (belt-and-suspenders; Blacksmith still
exists on bare `main`):

```sh
gh workflow disable CI --repo patroza/t3code
```

Layer green is **Fork CI** on each tip:

```sh
gh workflow run fork-ci.yml --repo patroza/t3code --ref fork/base
gh workflow run fork-ci.yml --repo patroza/t3code --ref fork/tim
gh workflow run fork-ci.yml --repo patroza/t3code --ref fork/candidates
```

Restack order: `main` → rebuild **`fork/base`** → `fork/tim` → `fork/candidates` → `fork/changes`
→ overlays → compose. Never bolt CI tip commits onto Tim/candidates product tips again.

Do not re-enable upstream CI on bare `main` to “make checks run.”

### Slow path — full provenance restack (local only)

Use a **local** restack when taking new upstream, Tim, or candidates — not after ordinary feature
merges. The GitHub Actions workflow **Rebase fork PR stack** is **`disabled_manually` and must stay
disabled.** Do not enable it, schedule it, or `gh workflow run rebase-pr-stack.yml`.

```sh
export GH_TOKEN="$(gh auth token)"
node scripts/rebase-pr-stack.ts sync --dry-run
node scripts/rebase-pr-stack.ts sync --push
```

That script fetches `pingdotgg/t3code:main`, verifies that the existing mirror has not diverged, and
atomically updates `main`, `fork/tim`, `fork/candidates`, `fork/changes`, and `fork/integration`
with force-with-lease when run with appropriate write credentials. A repository-scoped write deploy
key stored as `FORK_STACK_DEPLOY_KEY` can bypass branch rulesets for those updates (including
`main`'s PR and status-check requirements); it cannot access other repositories. Never expose or
reuse it. Prefer per-layer green gates even when using the script; stop the line on a red parent.

## Branch rulesets (protection vs rewrites)

Repository rulesets gate **long-lived stack branches**. Ordinary feature branches (`feat/**`,
`import/**`, …) are not covered, so agents and humans can still force-push them freely.

| Ruleset                                   | Branches                                                                                                      | Enforced                                                                                                                                                  | Bypass (always)                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Protect upstream main                     | `main`                                                                                                        | No delete, no force-push, linear history, **PR required**, **Fork CI checks**                                                                             | `patroza`, `omegabot`, deploy key (`FORK_STACK_DEPLOY_KEY`); Admin role may bypass via PR only |
| Protect fork/changes (PR + CI)            | `fork/changes`                                                                                                | No delete, no force-push, linear history, **PR required** (squash/rebase), **strict Fork CI** (Check, Test, Mobile Native Static Analysis, Release Smoke) | `patroza`, `omegabot`, deploy key                                                              |
| Protect integration overlays (PR + CI)    | `fork/discord`, `fork/vscode`, `fork/identity`, `t3-discord/f7d37879-desktop-deeplinks` (registered overlays) | Same as `fork/changes`: **PR required** (squash/rebase), **strict Fork CI** (Check, Test, Mobile Native Static Analysis, Release Smoke)                   | `patroza`, `omegabot`, deploy key (overlay auto-rebase / stack rewrites)                       |
| Protect fork/tim, candidates, integration | `fork/tim`, `fork/candidates`, `fork/integration`                                                             | No delete, no force-push, linear history (no PR requirement — stack rebuilds these tips)                                                                  | `patroza`, `omegabot`, deploy key                                                              |

**Overlay child PRs are not a free pass.** A PR whose base is a registered overlay (for example
`feat/…` → `fork/discord`) is subject to the same required checks as a PR into `fork/changes`.
Fork CI’s `pull_request.branches` list includes those overlay bases so Check/Test actually run
before merge. Compose does **not** re-lint; if a red overlay tip is ever force-pushed with bypass,
integration fails next — treat that as a process failure, not “CI will catch it later.”

**CI path:** compose / stack workflows authenticate with the deploy key for protected branch
pushes, not `GITHUB_TOKEN` alone (default workflow token is read-only and cannot be added as an
Integration bypass on this personal fork).

**Who cannot force-push protected branches:** write collaborators without a User bypass entry.
They can still open PRs into `fork/changes` or an overlay base and merge only when required checks
are green. **Bots and agents without a User bypass cannot merge red child PRs into overlays.**

**Who can force-push:** `patroza`, `omegabot` (must accept the collaborator invite), and the stack
deploy key. Feature-branch force-pushes do not need bypass. Bypass is for intentional stack rewrites
and overlay auto-rebase — **not** a license to skip local `vp check` / typecheck before push.

Upstream's `.github/workflows/ci.yml` and `.github/workflows/deploy-relay.yml` remain present on the
exact `main` mirror but are disabled in this repository. Fork PR and integration checks use
`.github/workflows/fork-ci.yml`; **Compose fork integration** (and the manual stack restack) dispatch
that workflow for the generated integration tip. This avoids redundant CI and prevents an
upstream-mirror update from being treated as a fork product or relay deployment.

## Starting work

The helper starts an independent branch from `fork/changes`:

```sh
pnpm fork:stack start feature/my-change
```

Commit and push normally, then open the PR against `fork/dev` (never against `main`). Updating
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
node scripts/compose-integration-overlays.ts --push
# or: gh workflow run compose-integration.yml --repo patroza/t3code --ref fork/changes
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

Prefer **`commit: "*"`** only for known permanent, non-product policies such as generated or
stack-owned metadata. Use a full SHA only for a one-shot non-product resolution. Product paths
cannot use either form: the tool rejects blind whole-file resolution and requires a 3-way merge.

Required workflow when automation stops on a conflict:

1. Note branch, `REBASE_HEAD` SHA, subject, and conflicted paths from the job summary / logs.
2. Decide `ours` vs `theirs` (or a hand-merged tree) for each path.
3. For non-product paths, **append** matching `conflictResolutions` entries to
   `.github/pr-stack.json` (durable `*` when the same path will keep that side on future rebases).
   For product paths, perform a 3-way merge in the preserved state; do not add a manifest entry.
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

**Never register automatic whole-file policies (durable `*` or exact SHA)** on:

- source under any current or future `apps/*/src/**`, `packages/*/src/**`, or `infra/*/src/**`
- `scripts/**`, `oxlint-plugin-t3code/**`, and root/workspace `package.json` manifests

Especially VCS clusters (`GitVcsDriverCore*`, `vcs.ts` / `vcsAction*`, BranchToolbar, CommandPalette,
`ws.ts`): taking main or Tim whole-file once produced tip-only `fix(stack)` patches (#165/#166).
Those patches are debt — fold them into the **related provenance/feature commit** on the next
rewrite (see [stack-history-rewrite.md](./stack-history-rewrite.md)).

When a conflict touches `apps/**` or `packages/**` product code:

1. **Do not** apply any manifest whole-file policy unless the path is documented as always taking
   one side for every rewrite and is **not** product code above. The stack tool rejects both
   wildcard and exact-SHA policies for product paths.
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

#### Disk-backed stack temp (`~/.t3/rebase-work`)

Stack rebase helpers (`rebase-pr-stack`, `rebase-integration-overlays`) place full git clones
under **`~/.t3/rebase-work/`** (or `T3_REBASE_WORK_ROOT` / `T3CODE_HOME/rebase-work` on t3vm),
never tmpfs `/tmp`. Same rationale as compose-work.

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

### Migration namespaces during provenance imports

Upstream and downstream migrations use independent manifests and ledgers:

| Owner                                        | Manifest                                      | SQLite ledger            | ID policy                             |
| -------------------------------------------- | --------------------------------------------- | ------------------------ | ------------------------------------- |
| `pingdotgg/t3code:main`                      | `migrationEntries` in `Migrations.ts`         | `effect_sql_migrations`  | Preserve upstream ID and name exactly |
| This fork, Tim imports, candidates, overlays | `forkMigrationEntries` in `ForkMigrations.ts` | `t3_fork_sql_migrations` | Allocate the next fork-local ID       |

The one-time namespace bootstrap backs up the old mixed ledger as
`effect_sql_migrations_backup_v1`, then regenerates `effect_sql_migrations` with canonical upstream
rows only. Never add a fork migration to it, and never avoid a collision by choosing a large
downstream ID. Effect's migrator uses the greatest numeric ID as a high-water mark, so a large fork
ID would suppress every later upstream migration below it.

This is a **required source adaptation** whenever rebuilding `fork/tim` or `fork/candidates`:

1. Diff every imported commit against its source and inspect changes under
   `apps/server/src/persistence/Migrations*`. Check both newly added migrations and edits or renames
   to existing migrations.
2. Keep migrations already present on upstream `main` in `Migrations.ts`, with the upstream numeric
   ID and name unchanged.
3. Move every migration introduced by Tim, an unmerged candidate, an overlay, or this fork into
   `ForkMigrations.ts`. Give it the next durable fork-local ID even if its source commit used an
   upstream-shaped filename or edited the shared manifest.
4. Rewrite follow-up changes to that migration in the fork copy. Do not modify the upstream
   migration to make it serve both histories.
5. If an imported migration was previously released through the legacy shared ledger, extend the
   namespace bootstrap with an exact legacy `(id, name)` mapping and a schema/data probe. Unknown
   legacy states must fail closed; never infer application from ID alone.
6. Run upgrade fixtures for every known released ledger shape, plus a fresh database and a database
   where an upstream and fork migration have the same local numeric ID.

When an upstream candidate is accepted, remove its provenance commit during the candidates rebuild
but keep its historical fork-ledger assignment reserved. If upstream ships equivalent schema under
an upstream ID, make both migrations idempotent or add an explicit reconciliation step; never relabel
the old fork ledger row as proof that the upstream migration ran.

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

The provenance description must also list every migration that was moved or rewritten into the fork
namespace. A candidate migration remaining in the upstream manifest is an incomplete import even if
the layer currently passes on a fresh database.

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
