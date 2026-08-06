# Stable Development and Release Branch Handover

## Status

Staged plan. This document describes a migration away from using the continuously rebased fork
stack as the daily contributor and release path.

**Steps 1 and 2 deliver the entire daily benefit and are the only steps required to start.**
Everything after them is optional, incremental, and can be deferred indefinitely without losing
what steps 1 and 2 gained. In particular, generated clean downstream history and periodic
projection releases are **not** prerequisites and are **not** on the critical path.

The intended outcome is:

- Contributors work against a stable branch whose history is never rewritten.
- A green merge can be released immediately or according to a configurable cadence.
- The useful upstream, base, Tim, and candidate provenance layers remain clean and rebased.
- Routine work does not require contributors to label desktop, mobile, server, or other affected
  clients manually.
- Clean downstream history remains available as generated output rather than an authoring surface —
  if and when it is actually wanted.

## Adopt Now, Defer the Rest

| Capability                                       | When       | Blocking? | Why                                                    |
| ------------------------------------------------ | ---------- | --------- | ------------------------------------------------------ |
| `fork/dev` stable branch, default PR base        | **Step 1** | Yes       | Removes rebase churn from every contributor            |
| Deploy from an exact green `fork/dev` SHA        | **Step 1** | Yes       | Ops already deploys an exact SHA; only the ref changes |
| Path/dependency-inferred check and release scope | **Step 2** | No        | Removes manual client labelling                        |
| Per-target release records and cadence policy    | **Step 2** | No        | Lets bot/server ship faster than desktop/mobile        |
| Overlay drain into `fork/dev`                    | Step 3     | No        | Happens naturally once overlays stop being rebased     |
| Automated `fork/candidates` tree-delta sync      | Later      | No        | Manual sync is fine at the current upstream cadence    |
| `fork/changes-clean` / `fork/integration-clean`  | If needed  | No        | Audit/upstreaming artifact, not a release input        |
| Periodic clean projection and tree proofs        | If needed  | No        | Only useful when upstreaming or auditing is due        |

The rebased provenance stack (`main → fork/base → fork/tim → fork/candidates`) keeps working exactly
as it does today throughout. Nothing regresses if the clean-projection work is never built.

## Current Problem

The current runnable branch is produced through a fully rewritten stack:

```text
upstream/main
  -> fork/base
  -> fork/tim
  -> fork/candidates
  -> fork/changes
  -> identity/Discord/VS Code/desktop overlays
  -> fork/integration
```

This gives the fork good provenance, but it couples ordinary development and releases to expensive
history maintenance:

- Rebases change commit identities and invalidate contributor bases.
- Every upstream update can require the entire stack and all overlays to be rewritten.
- Small bot, server, desktop, or mobile fixes cannot ship until unrelated layers are green again.
- Conflicts in an early provenance layer block downstream releases.
- Permanent overlays add composition and synchronization work to otherwise ordinary features.

Git cannot provide stable commit identities and continuously rebased history on the same branch.
The solution is to give stable development and clean projection different branches and different
responsibilities.

## Proposed Topology

Retain a clean provenance stack through `fork/candidates`, then feed its changes into a stable,
complete development branch:

```text
upstream/main
  -> fork/base
  -> fork/tim
  -> fork/candidates       periodically rebased provenance stack
             |
             | reviewed tree-delta synchronization
             v
         fork/dev          stable complete product
             ^                 |
             |                 +-> CI -> immediate or scheduled releases
             |
             +-- ordinary downstream PRs
             +-- identity work
             +-- Discord work
             +-- VS Code work
             +-- web/mobile/desktop/server/bot work

  (optional, later)
  fork/dev checkpoint
    -> fork/changes-clean
    -> fork/integration-clean    generated on demand, never a PR base
```

## Branch Responsibilities

| Branch                   | Rewritten           | Contributor target | Release source | Purpose                                     |
| ------------------------ | ------------------- | ------------------ | -------------- | ------------------------------------------- |
| `main`                   | Yes, mirror-managed | No                 | No             | Exact upstream mirror                       |
| `fork/base`              | Yes                 | No                 | No             | Fork repository and CI infrastructure       |
| `fork/tim`               | Yes                 | No                 | No             | Selected Tim imports with provenance        |
| `fork/candidates`        | Yes                 | No                 | No             | Selected unmerged upstream candidates       |
| `fork/dev`               | Never               | Yes                | Yes            | Canonical complete downstream product       |
| `fork/changes-clean`     | Yes                 | No                 | No (optional)  | Curated downstream projection, if built     |
| `fork/integration-clean` | Yes                 | No                 | No (audit)     | Clean composed output matching a checkpoint |

The clean branch names are placeholders and only matter once that work is actually scheduled.

## Core Invariants

### Stable development

- `fork/dev` is never rebased or force-pushed after cutover.
- Ordinary contributor PRs target `fork/dev`.
- Contributor branches never depend on generated projection branches.
- The complete application can be built, tested, and run directly from `fork/dev`.
- A clean-stack rebuild is not required for a routine release.

### Exact releases

- Every release refers to an exact, green `fork/dev` SHA.
- Deployment receives the same SHA that passed the required checks.
- Bot, server, desktop, and mobile release status can be recorded independently.
- Release timing is policy, not branch topology: it may be immediate, debounced, scheduled, or
  manually promoted.

### Clean provenance

- `main`, `fork/base`, `fork/tim`, and `fork/candidates` retain their current provenance roles.
- Rewritten provenance tips are never merged into `fork/dev`; their tree delta is imported instead.
- Any generated clean branches are output only, may be rewritten safely, and are never merged back.

## Step 1 — Cut Over to `fork/dev`

This is the whole of the immediate benefit. It is a ref change plus branch protection, not a
re-architecture.

1. Create `fork/dev` from the current green `fork/integration` tip.
2. Prove the initial trees are identical: `git diff --exit-code fork/integration fork/dev`.
3. Record the incorporated `fork/candidates` checkpoint (commit + tree).
4. Protect `fork/dev` against force-push and deletion; configure required checks.
5. Set squash as the repository's default merge method (see
   [Merge policy](#merge-policy-squash-decided)).
6. Make `fork/dev` the GitHub default branch and the base for ordinary contributor PRs.
7. Point deployment at `fork/dev` (see [Ops Repository Changes](#ops-repository-changes)).
8. Keep the old compose-and-deploy path installed as a temporary fallback.

### Cutover consequence: overlays are landed, not skipped

Because `fork/dev` is cut from `fork/integration` — not from `fork/changes` — **overlay content is
already present in `fork/dev` from its first commit**. This is deliberate: the runnable product must
not regress at cutover.

The consequence is that every registered overlay must be drained rather than left open:

- An overlay whose content is fully contained in the cutover tip is **done**. Close its PR, remove
  it from `.github/pr-stack.json`, and stop rebasing it.
- An overlay with work not yet in the cutover tip is rebased **onto `fork/dev`** once, then merged
  as an ordinary PR.
- Leaving an overlay open against `fork/changes` after cutover will duplicate its commits the next
  time anything composes. Drain first, then cut over — or cut over and drain the same day.

This is the one ordering hazard in the migration. Everything else is additive.

## Step 2 — Release Directly from `fork/dev`

1. Update release workflows to accept an exact green `fork/dev` SHA.
2. Implement path/dependency-based scope classification (below).
3. Track per-target release outcomes independently.
4. Add immutable checkpoint tags for approved releases.
5. Exercise bot, server, desktop, and mobile paths once.
6. Stop requiring full-stack composition for routine releases.

### Inferring validation and release scope

Daily contributors should not manually classify their work as web, mobile, desktop, server, or bot.
Automation should derive affected surfaces from the diff and the workspace dependency graph.

Illustrative path rules:

```text
apps/mobile/**             -> mobile checks and release scope
apps/desktop/**            -> desktop checks and release scope
apps/server/**             -> server and bot checks/release scope
apps/web/**                -> web checks
apps/discord/**            -> Discord checks
apps/vscode/**             -> VS Code checks
packages/contracts/**      -> all relevant producers and consumers
packages/client-runtime/** -> web and mobile
shared build/config paths  -> conservative full validation
```

Unknown or ambiguous shared paths must fail safely by selecting broader checks, never by requiring a
label. `scripts/classify-deployment-diff.sh` already performs this classification for deployment; the
same classifier should drive PR check selection so the two cannot disagree.

Labels remain appropriate only for exceptional intent that cannot be inferred from code — for
example requesting an unusual release behaviour, or recording an unusual external import.

### Release policies

`fork/dev` supports multiple release policies without changing the branch model.

**Immediate:** after a merge, obtain CI for the exact resulting `fork/dev` SHA, infer affected
targets from the previous approved SHA, dispatch, and record each outcome. Suitable for urgent bot,
server, or desktop fixes.

**Lagged:** merges accumulate and are promoted after a debounce period, every few hours, daily, or
at a manually selected checkpoint — and on different schedules per product. Bot and server can be
frequent while desktop and mobile use a slower cadence. These are policy decisions requiring no
additional integration branches.

Approved releases reference immutable checkpoints, for example `fork-dev/2026-08-06.1`. Each
deployment record should include the `fork/dev` SHA, CI run and conclusion, calculated change scope,
and independent bot / server / desktop / mobile status. **A partial multi-target release must not be
represented as completely deployed.**

## Ops Repository Changes

Deployment already promotes an exact CI-approved SHA, so the cutover is a _ref_ change, not a
mechanism change. The private ops repository currently hardcodes `fork/integration` in the poller,
deployer, clone preparation, failure notifier, and laptop catch-up.

The prerequisite ops change is to make the trusted branch, CI workflow, and CI trigger event
configurable, defaulting to today's values so nothing changes until the cutover:

```sh
T3CODE_DEPLOY_BRANCH=fork/integration     # -> fork/dev at cutover
T3CODE_DEPLOY_CI_WORKFLOW=fork-ci.yml
T3CODE_DEPLOY_CI_EVENT=workflow_dispatch  # -> push at cutover
```

Cutover is then a single `deploy.env` edit on the deployment host plus a poller restart, and
reverting is the same edit.

Component checkpoint state files (`fork-integration-<component>-sha`) keep their names across the
cutover on purpose. Their value is the last deployed SHA used for tree-diff classification, and
because `fork/dev` starts at the `fork/integration` tip those SHAs remain valid ancestors — so the
cutover does not trigger a full fleet redeploy.

## Daily Contributor Workflow

After step 1 the normal path is:

1. Create a feature branch from `fork/dev`.
2. Open a PR against `fork/dev`.
3. Run the mandatory local validation.
4. Run GitHub CI for the exact PR and merge tip.
5. Squash merge.
6. Release immediately or in the next release cadence.

No restack or overlay composition is required for an ordinary feature or fix.

### Merge policy: squash (decided)

**Squash merge is the standard for PRs into `fork/dev`.** Every GitHub PR becomes exactly one stable
commit, which is what makes the rest of this document work: the PR ledger maps one-to-one onto
`fork/dev` history, release scope is a diff between two commits, and a later clean projection has a
single unit to replay per PR.

Exceptions are not defined yet. If a case appears where preserving a dependent series on `fork/dev`
genuinely matters, it can be argued on its own merits then. Until that happens, treat squash as the
only merge method — and set GitHub's repository default accordingly rather than relying on
contributors picking the right button. Leaving the other merge methods enabled is fine while the
exception question is open; making one the default is not.

Release only the exact merge SHA after its required checks pass. A green PR tip is not sufficient if
the resulting merge SHA differs or the base moved.

## Identity, Discord, and VS Code

Identity, Discord, and VS Code remain meaningful ownership areas, but they do not need permanent
composition overlays.

Their feature PRs target `fork/dev` directly. Ownership and validation are inferred from paths and
dependency impact — Discord's and VS Code's separate directories naturally select their own checks
and owners; shared package changes expand validation to affected consumers. Use path-based workflow
filters and `CODEOWNERS` instead of requiring contributors to apply client labels.

If one of these areas genuinely needs independent staging, it may later use a stable, never-rebased
branch such as `fork/discord-dev`. Work merges into `fork/dev`, and `fork/dev` merges back
afterwards. This adds merge topology and administration, so introduce it only where separate staging
provides a concrete benefit. Clear folders alone are not sufficient justification.

Likewise, ordinary cross-cutting features — the desktop URL-handler enhancement, for example —
become ordinary squash-merged PRs on `fork/dev`, not permanent layers. A dedicated layer is
justified only when work has independent external provenance or must remain independently staged.

## Synchronizing the Rebased Stack into `fork/dev`

Rewritten provenance branches must not be repeatedly merged into `fork/dev`. After a rebase their
commits have new identities; merging the rewritten tip would duplicate history and produce avoidable
conflicts. Synchronize the net tree change instead.

Assume `C1` is the `fork/candidates` tree currently incorporated into `fork/dev`, and `C2` is the
latest rebuilt and verified `fork/candidates` tree. Then:

1. Create a sync branch from `fork/dev`.
2. Calculate the tree delta from `C1` to `C2` and apply it to the sync branch.
3. Resolve integration conflicts against the current `fork/dev` product tree.
4. Run the full required checks.
5. Open a normal PR into `fork/dev`, titled for example
   `sync(provenance): import upstream stack C1..C2`.
6. Merge it without rewriting `fork/dev`.
7. Record `C2` as the newly imported provenance checkpoint.

**This is a manual procedure to begin with, and that is fine.** At the current upstream cadence it
runs rarely enough that automation is a convenience, not a prerequisite. The imported checkpoint may
be recorded in an immutable tag or a small machine-owned state file:

```json
{
  "importedCandidatesCommit": "<commit>",
  "importedCandidatesTree": "<tree>",
  "importedUpstreamCommit": "<commit>"
}
```

Automate it later by persisting the last imported commit and tree, building the `C1..C2` sync branch
automatically, opening a reviewed PR, and updating the checkpoint only after that PR merges.

## GitHub PRs as the Development Ledger

GitHub PR history is the primary daily ledger. Do not create a second manifest containing every
normal contributor PR. Merge order, stable squash commits, changed paths, PR relationships, and
checkpoint tags already carry the information.

Explicit metadata is required only when the work cannot speak for itself. Tim and candidate import
PRs should record immutable source information:

```text
Source-Repository: <owner/repository>
Source-PR: <number>
Source-SHA: <commit>
Fork-Layer: tim|candidate
```

This is worth adopting immediately even though the projection work is deferred — the trailers cost
nothing on an import PR and are hard to reconstruct afterwards.

## Deferred — Clean Downstream Projection

**Not required to reap the benefits above.** Skip this entire section until there is a concrete
need: upstreaming a series, an external audit, or a major release that wants a curated history.
Nothing in steps 1–3 depends on it.

When it is scheduled, clean downstream history is generated on demand from a tagged, green
`fork/dev` checkpoint plus rebuilt `fork/base`, `fork/tim`, and `fork/candidates`:

1. Select and tag a green `fork/dev` checkpoint.
2. Update the upstream mirror; rebuild and verify `fork/base`, `fork/tim`, and `fork/candidates`.
3. Select the downstream PRs represented in the checkpoint, excluding provenance-sync commits whose
   content is already represented below.
4. Replay downstream features into `fork/changes-clean`, folding explicitly linked repairs
   (`Projection-Fold-Into: <fork PR number>`) into their owning feature commits.
5. Compose `fork/integration-clean` and run the per-layer gate in stop-the-line order.
6. Verify tree equivalence with the selected checkpoint:

   ```bash
   git diff --exit-code <fork-dev-checkpoint> <fork-integration-clean>
   ```

7. Publish generated branches only after all checks pass.

Expected differences must be narrowly documented and machine-verifiable; broad path exclusions are
not acceptable, because they are how a projection silently drops downstream behaviour.

A projection failure blocks publication of the generated clean stack only. It does not rewrite or
block `fork/dev`, does not block releases from an already-green `fork/dev` SHA, and produces an
actionable report identifying the PR, layer, commit, and conflicting paths.

A small manifest remains useful for machine policy GitHub cannot infer — layer ordering, external
import sources, persistent conflict-resolution rules, explicit exclusions, ordering constraints,
fix-to-feature folding overrides, and exceptional commits that did not originate in a PR. It should
not duplicate the GitHub PR overview.

The existing full stop-the-line per-layer gate is retained for this work. It is appropriate for
periodic provenance maintenance and must not sit in the path of a routine product release.

## Migration Plan

### Step 1 — Establish `fork/dev` (do now)

See [Step 1](#step-1--cut-over-to-forkdev). Includes the ops deploy-branch parameterization and the
overlay drain.

### Step 2 — Release from `fork/dev` (do now)

See [Step 2](#step-2--release-directly-from-forkdev).

### Step 3 — Simplify overlays (as they drain)

1. Route new identity, Discord, and VS Code PRs directly to `fork/dev`.
2. Move ownership to `CODEOWNERS` and path-based CI.
3. Retire permanent composition overlays once no open work depends on them.
4. Stop targeting `fork/changes` with contributor PRs and stop composing overlays after every merge.

### Step 4 — Automate provenance synchronization (when manual becomes tedious)

Persist the last imported candidates commit and tree, build the `C1..C2` sync branch automatically,
open a reviewed PR, run the full gate, and update the checkpoint only after merge. Never merge a
rewritten provenance branch directly into `fork/dev`.

### Step 5 — Automate clean projection (only if needed)

Only once the deferred projection above is actually wanted: query PRs between checkpoint tags, infer
ordinary changes from commits and paths, replay into clean layers, apply durable conflict policies,
verify every rewritten layer, prove tree equivalence, and publish.

## Operational Rules

1. Never force-push or rebase `fork/dev`.
2. Never merge a rewritten provenance tip directly into `fork/dev`; import its tree delta.
3. Never require a clean projection rebuild to ship an unrelated urgent fix.
4. Never release an untested `fork/dev` SHA; release the exact merge SHA, not the PR tip.
5. Every ordinary product change enters through a GitHub PR, squash merged.
6. Daily contributors do not manually classify affected clients when paths and dependencies can.
7. External imports record immutable source provenance at import time.
8. If generated projection branches exist, never merge them into `fork/dev` and never use one as a
   PR base.

## Settled Decisions

- **Merge policy: squash.** Every PR into `fork/dev` becomes one commit. Whether any exception is
  warranted is left open until a concrete case appears. See
  [Merge policy](#merge-policy-squash-decided).

## Open Decisions

None of these block step 1 or step 2:

- Immediate, debounced, scheduled, or manual release cadence for each target.
- Frequency of upstream/provenance synchronization.
- Whether identity, Discord, or VS Code needs a stable subsystem staging branch.
- Whether clean downstream projection is ever built, and if so on what trigger.
- Naming of the generated clean branches.
- Exact rules for mapping shared-package changes to downstream consumers.

## Recommended Decision

Adopt the following operating principle:

> Rebase external provenance; squash stable product development onto `fork/dev`; release exact green
> `fork/dev` checkpoints; generate clean downstream history separately — and only when it is
> actually needed.

Steps 1 and 2 can land in a single day: cut `fork/dev` from the green `fork/integration` tip, drain
the overlays, flip the ops deploy branch, and release from exact green SHAs. That removes daily
rebases from contributor and release workflows and removes routine label administration immediately,
while preserving the ability to produce a clean, auditable downstream history later if it is ever
worth the cost.
