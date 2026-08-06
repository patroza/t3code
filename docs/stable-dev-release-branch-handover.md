# Stable Development and Release Branch Handover

## Status

**Adopted and live since 2026-08-06.** `fork/dev` is the default branch, the contributor target and
the release source. This document is the record of the model and of what the cutover surfaced, not a
proposal.

What is in place:

|                                                                                          |                                     |
| ---------------------------------------------------------------------------------------- | ----------------------------------- |
| `fork/dev` cut from the green `fork/integration` tip `21badd04e`, trees proven identical | tag `fork-dev/2026-08-06.1`         |
| Default branch, ruleset, squash-only merges, required checks                             | live                                |
| CI wired for `fork/dev` pull requests and merges                                         | #343                                |
| Deployment promoting exact green `fork/dev` SHAs                                         | ops `deploy.env` on the deploy host |
| Validation and release split into separate workflows                                     | #347, #349                          |
| First provenance sync, upstream `2a04db134..a2ca89aa1`                                   | #345, tag `fork-dev/2026-08-06.2`   |
| Upstream ancestry recorded so "behind" reads true                                        | `3a7e7a458`                         |
| Integration overlays drained and deregistered                                            | #348                                |

What is deliberately not done: clean downstream projection (see
[Deferred](#deferred--clean-downstream-projection)), automated provenance sync, and retirement of the
overlay machinery itself.

`fork/changes` is frozen at `271c4b228` and `fork/integration` at `21badd04e`. Neither is a
contributor target or a release source any longer; they are kept only until the remaining PRs still
based on `fork/changes` are drained.

The intended outcome, all of which now holds:

- Contributors work against a stable branch whose history is never rewritten.
- A green merge can be released immediately or according to a configurable cadence.
- The useful upstream, base, Tim, and candidate provenance layers remain clean and rebased.
- Routine work does not require contributors to label desktop, mobile, server, or other affected
  clients manually.
- Clean downstream history remains available as generated output rather than an authoring surface —
  if and when it is actually wanted.

## What Remains

| Work                                         | State                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| PRs still based on `fork/changes`            | #317, #226, #185 conflict on rebase; #237 and #238 live in an external fork and need their author |
| Retire `fork/changes` and `fork/integration` | blocked on the above                                                                              |
| Overlay and stack machinery                  | **removed.** `.github/pr-stack.json` survives only as the managed-PR allowlist for the draft lock |
| Automated provenance synchronization         | manual, and fine at the current upstream cadence                                                  |
| Clean downstream projection                  | deferred indefinitely; nothing depends on it                                                      |
| Per-target release cadence                   | still immediate for everything                                                                    |

The rebased provenance stack (`main → fork/base → fork/tim → fork/candidates`) works exactly as it
did before and is unaffected by any of the above.

## The Problem This Solved

The runnable branch used to be produced through a fully rewritten stack:

```text
upstream/main
  -> fork/base
  -> fork/tim
  -> fork/candidates
  -> fork/changes
  -> identity/Discord/VS Code/desktop overlays
  -> fork/integration
```

That gave the fork good provenance, but coupled ordinary development and releases to expensive
history maintenance:

- Rebases change commit identities and invalidate contributor bases.
- Every upstream update can require the entire stack and all overlays to be rewritten.
- Small bot, server, desktop, or mobile fixes cannot ship until unrelated layers are green again.
- Conflicts in an early provenance layer block downstream releases.
- Permanent overlays add composition and synchronization work to otherwise ordinary features.

Git cannot provide stable commit identities and continuously rebased history on the same branch.
The solution is to give stable development and clean projection different branches and different
responsibilities.

## Topology

A clean provenance stack is retained through `fork/candidates`, and its changes are fed into a
stable, complete development branch:

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

| Branch                   | Rewritten           | Contributor target | Release source | Purpose                                       |
| ------------------------ | ------------------- | ------------------ | -------------- | --------------------------------------------- |
| `main`                   | Yes, mirror-managed | No                 | No             | Exact upstream mirror                         |
| `fork/base`              | Yes                 | No                 | No             | Fork repository and CI infrastructure         |
| `fork/tim`               | Yes                 | No                 | No             | Selected Tim imports with provenance          |
| `fork/candidates`        | Yes                 | No                 | No             | Selected unmerged upstream candidates         |
| `fork/dev`               | Never               | Yes                | Yes            | Canonical complete downstream product         |
| `fork/changes`           | Was                 | No, frozen         | No             | Superseded by `fork/dev`; retire once drained |
| `fork/integration`       | Was                 | No, frozen         | No             | Superseded by `fork/dev`; retire once drained |
| `fork/changes-clean`     | Yes                 | No                 | No (optional)  | Curated downstream projection, if built       |
| `fork/integration-clean` | Yes                 | No                 | No (audit)     | Clean composed output matching a checkpoint   |

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
- `upstream/main` is merged into `fork/dev` directly. The rebased provenance branches are not
  merged into it at all — their commit identities change, so merging a tip would duplicate history.
- Any generated clean branches are output only, may be rewritten safely, and are never merged back.

## How the Cutover Was Done

A ref change plus branch protection, not a re-architecture.

1. `fork/dev` created from the green `fork/integration` tip `21badd04e`.
2. Trees proven identical — `git diff --exit-code fork/integration fork/dev`, both `a8a2b757a`.
3. Incorporated `fork/candidates` checkpoint recorded in tag `fork-dev/2026-08-06.1`.
4. `fork/dev` protected by the ruleset _Protect fork/dev (PR + CI)_: `deletion`,
   `required_linear_history`, `non_fast_forward`, `pull_request` restricted to squash, and required
   checks `Check` / `Test` / `Mobile Native Static Analysis` / `Release Smoke`.
5. Merge commits and rebase merging disabled repository-wide, so squash is the only method; the sync
   automation holds a ruleset bypass actor so the upstream merge can still be pushed.
6. `fork/dev` made the GitHub default branch and the base for contributor PRs.
7. Deployment pointed at `fork/dev` (see [Ops](#ops)).

Required checks were added **after** CI was wired to run for `fork/dev`. Requiring a check that
cannot yet run blocks the very PR that makes it runnable — the ordering matters.

`strict_required_status_checks_policy` is deliberately `false`. Strict would invalidate every open
PR's checks on each merge; it is safe to relax because every merge SHA is validated by its own push
run, and deployment only promotes green SHAs.

### Overlays were landed, not skipped

Because `fork/dev` was cut from `fork/integration` — not from `fork/changes` — overlay content was
present in `fork/dev` from its first commit. That was deliberate: the runnable product must not
regress at cutover.

The consequence was that every registered overlay had to be drained rather than left open. Leaving
one open against `fork/changes` would duplicate its commits the next time anything composed. All
four were verified contained **by path**, not by subject — the only commits not present touched
`pnpm-lock.yaml` alone, regeneration artifacts that compose discards by its own rule — then closed
and deregistered in #348.

### What the cutover surfaced

The old path hid several faults that only a real cutover could expose. They are recorded because
each cost a round trip:

- **`fork/dev` had no CI path at all.** `fork-ci.yml` listed only the rebased stack layers and the
  overlays as `pull_request` bases and had no `push` trigger, so required checks were impossible and
  no run would ever exist for a merge SHA (#343).
- **Mobile releases would have stopped silently.** The release jobs were gated on
  `workflow_dispatch` + `fork/integration`; nothing errors when they simply never fire again (#343).
- **Both mobile workflows hardcoded `ref: fork/integration`** and then asserted the requested SHA was
  contained by that checkout, so every `fork/dev` SHA was rejected (#344, #346).
- **A release failure could veto a validation verdict.** A failed EAS dispatch marked a valid SHA
  unapprovable and stranded the whole fleet, which is why validation and release are now separate
  workflows (#347).
- **Every PR based on `fork/changes` was already broken.** Because `fork/changes` had been rebased,
  GitHub reported them as 60–100 commits and 629–741 changed files. Each turned out to be one commit
  of real work on stale history; the fix was to cherry-pick that commit onto `fork/dev`, not to
  replay the branch.

## Releasing from `fork/dev`

Every release refers to an exact green `fork/dev` SHA. Two workflows, deliberately separate:

| Workflow           | Answers                      | Consumed by                              |
| ------------------ | ---------------------------- | ---------------------------------------- |
| `fork-ci.yml`      | "is this SHA valid?"         | the deploy poller, and branch protection |
| `fork-release.yml` | "release this validated SHA" | nothing — terminal                       |

`fork-release` is chained on `workflow_run` and starts only after `fork-ci` **concludes success** for
a `push` on `fork/dev`. Its manual `workflow_dispatch` path re-checks that green verdict against the
API rather than trusting the operator.

This split exists because a release action must never be able to veto a validation verdict. When
mobile dispatch lived inside `fork-ci`, a failed EAS call marked a valid SHA unapprovable and
stranded server, Discord, desktop and VS Code promotion of a perfectly good commit.

Consequences worth knowing:

- Release failures are recorded against the release run. The poller queries `fork-ci.yml` and never
  sees them.
- `workflow_run` only fires for workflow files on the **default branch**. This works because
  `fork/dev` is the default branch; it would silently do nothing otherwise.
- Server, Discord, desktop and VS Code are promoted by the poller pulling from the green `fork-ci`
  run. Only mobile is dispatched by `fork-release`.

The release summary reports what the SHA would move, classified by
`scripts/classify-deployment-diff.sh` — the same script the poller runs, so the report and the fleet
cannot disagree about what a diff means. It compares against the previous _released_ SHA, while the
poller compares against the last SHA it actually _deployed_; when those diverge the poller selects a
superset of the reported targets, never a subset.

### Inferring release scope

Daily contributors do not manually classify their work as web, mobile, desktop, server, or bot.
`scripts/classify-deployment-diff.sh` derives the affected surfaces from the diff, and both the
poller and `fork-release` run it, so no label is required to ship.

**Check selection is not inferred and probably should not be.** Every PR into `fork/dev` runs all
four required checks regardless of the paths it touches. That is the conservative choice, and until
the suite is slow enough to hurt it is also the correct one: a path filter that is wrong in the
narrow direction silently skips a check on a protected branch.

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

Unknown or ambiguous shared paths fail safely by selecting broader scope, never by requiring a
label. If check selection is ever narrowed, it must be driven by this same classifier so the two
cannot disagree about what a diff means.

Labels remain appropriate only for exceptional intent that cannot be inferred from code — for
example requesting an unusual release behaviour, or recording an unusual external import.

### Release policies

`fork/dev` supports multiple release policies without changing the branch model.

**Immediate — the current policy for every target.** After a merge, `fork-ci` validates the exact
resulting SHA, `fork-release` infers affected targets from the previous released SHA and dispatches,
and the poller promotes the rest within its 30-second cycle.

**Lagged — available, not adopted.** Merges could instead accumulate and be promoted after a
debounce period, every few hours, daily, or at a manually selected checkpoint, on different schedules
per product. That is a policy change in `fork-release` and the poller cadence; it needs no additional
integration branches.

Approved releases reference immutable checkpoints, for example `fork-dev/2026-08-06.1`. Each
deployment record should include the `fork/dev` SHA, CI run and conclusion, calculated change scope,
and independent bot / server / desktop / mobile status. **A partial multi-target release must not be
represented as completely deployed.**

## Ops

Deployment already promoted an exact CI-approved SHA, so the cutover was a _ref_ change, not a
mechanism change. The private ops repository had hardcoded `fork/integration` in the poller,
deployer, clone preparation, failure notifier and laptop catch-up; those now resolve through one
shared library:

```sh
T3CODE_DEPLOY_BRANCH=fork/dev             # default fork/integration
T3CODE_DEPLOY_CI_EVENT=push               # default workflow_dispatch
T3CODE_CONTRIBUTOR_BRANCH=fork/dev        # default fork/changes
T3CODE_DEPLOY_CI_WORKFLOW=fork-ci.yml
```

Set in `deploy.env` on the deployment host, which the poller unit reads via `EnvironmentFile=-` and
the library parses directly as plain `KEY=VALUE` — never sourced as shell, so a config file cannot
execute code. Defaults reproduce the pre-cutover behaviour exactly, so reverting is deleting that
file.

Component checkpoint state files (`fork-integration-<component>-sha`) keep their names across the
cutover on purpose. Their value is the last deployed SHA used for tree-diff classification, and
because `fork/dev` started at the `fork/integration` tip those SHAs remained valid ancestors — so the
cutover did not trigger a full fleet redeploy.

The poller keys on a successful `fork-ci` **push** run for the exact SHA. Because release actions
were moved out of that workflow, a release failure can no longer withhold a fleet promotion.

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

One exception is known: **provenance sync PRs are merge-committed, not squashed**, because
squashing discards the upstream ancestry link that makes "commits behind upstream" readable. See
[Synchronizing Upstream](#synchronizing-upstream-into-forkdev).

Beyond that, exceptions are not defined. If a case appears where preserving a dependent series on
`fork/dev` genuinely matters, it can be argued on its own merits then.

Enforce this in repository settings rather than by asking contributors to pick the right button.
GitHub has no "default merge method" field: the merge button's primary action is whichever method is
enabled, in the order merge commit → squash → rebase. Squash only becomes the default by disabling
the other two:

```sh
gh api -X PATCH repos/<owner>/<repo> \
  -F allow_squash_merge=true -F allow_merge_commit=false -F allow_rebase_merge=false
```

That also makes an exception a deliberate act — someone has to re-enable a method to take one — which
is the right shape for a policy whose exceptions are undefined. Pair it with
`required_linear_history` on `fork/dev` so the invariant holds even if a setting is changed later.

Leave merge commits disabled even though provenance syncs need one. Re-enabling them repo-wide makes
**Merge** the merge button's primary action again — GitHub picks it in the order merge → squash →
rebase — which quietly reverses this decision for every ordinary PR. Give the sync automation a
ruleset **bypass actor** instead, so it can push the upstream merge directly while every human path
stays squash-only.

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

## Synchronizing Upstream into `fork/dev`

Merge it:

```sh
git fetch upstream main
git merge upstream/main        # resolve, verify, then push to fork/dev
git push origin upstream/main:main   # fast-forward the mirror
```

`upstream/main` is append-only and its commit identities are permanent, so a merge is sound and
`fork/dev` gains upstream's commits as real ancestors. "Commits behind upstream" then reads true on
the branch page, and the merge base advances, so the next sync replays only what is genuinely new.
The first such merge replayed three commits, not the whole divergence.

Do **not** press GitHub's **Sync fork** button. It merges into the default branch on GitHub's terms
rather than after local verification, and there is no opportunity to resolve or run the gate first.

### Verify before pushing, not after

The merge lands directly on `fork/dev` — it cannot go through the squash-only PR path without
flattening the second parent and discarding the ancestry. So the merge is validated locally and
pushed with a ruleset bypass, rather than reviewed in a PR.

That makes local verification the only gate, and it must be the full one: recursive typecheck and the
test suite. **A clean textual merge is not evidence of a working one.** Every sync so far has hit
integration breakage that produced no conflict at all — most recently upstream adding a parameter to
`resolveSnoozePresets` and updating its own call sites, while the fork's board code kept the old
arity. Git had nothing to say about it; the typechecker did.

### What this replaced

Earlier syncs rebuilt `fork/base` → `fork/tim` → `fork/candidates` onto the new upstream tip,
computed the tree delta between the previous and new `fork/candidates` trees, applied that delta to
`fork/dev`, and then recorded ancestry with `git merge -s ours`.

That existed because those provenance branches are rebased, so merging their tips would duplicate
history. It was never necessary for upstream itself, which is not rebased. The rebuild also meant a
conflict in an early layer blocked the import entirely — the exact coupling this whole document set
out to remove, reintroduced one level up. The stack tooling that drove it has been removed.

`fork/base`, `fork/tim` and `fork/candidates` still exist and still record which upstream and Tim
work was selected, but they are no longer rebuilt on every upstream update.

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

## Remaining Migration Steps

Steps 1 and 2 — establishing `fork/dev` and releasing from it — are done; see
[How the Cutover Was Done](#how-the-cutover-was-done) and
[Releasing from `fork/dev`](#releasing-from-forkdev).

### Finish draining `fork/changes`

The registered overlays are drained and deregistered. What is left are the ordinary PRs still based
on `fork/changes`: #317, #226 and #185 conflict when their real commit is cherry-picked onto
`fork/dev`, and #237 and #238 live in an external fork and need their author. Once those are
resolved, `fork/changes` and `fork/integration` can be deleted. The composition workflows and stack
tooling are already gone.

### Automate the upstream merge (when manual becomes tedious)

The merge itself is one command; what takes the time is verifying it and resolving the integration
breakage that produces no conflict. Automating the mechanical half is easy and would help least.

### Automate clean projection (only if needed)

Only once the deferred projection below is actually wanted: query PRs between checkpoint tags, infer
ordinary changes from commits and paths, replay into clean layers, apply durable conflict policies,
verify every rewritten layer, prove tree equivalence, and publish.

## Operational Rules

1. Never force-push or rebase `fork/dev`.
2. Merge `upstream/main` into `fork/dev` directly, and never a rebased provenance tip.
3. Never require a clean projection rebuild to ship an unrelated urgent fix.
4. Never release an untested `fork/dev` SHA; release the exact merge SHA, not the PR tip.
5. Every ordinary product change enters through a GitHub PR, squash merged.
6. Never let a release action decide whether a SHA is valid.
7. Daily contributors do not manually classify affected clients when paths and dependencies can.
8. External imports record immutable source provenance at import time.
9. If generated projection branches exist, never merge them into `fork/dev` and never use one as a
   PR base.

## Settled Decisions

- **Merge policy: squash.** Every PR into `fork/dev` becomes one commit, enforced by disabling merge
  and rebase merging repository-wide and by the `fork/dev` ruleset. The one exception is the upstream
  merge, pushed with a ruleset bypass because squashing it would discard the second parent and with
  it the upstream ancestry. See [Merge policy](#merge-policy-squash-decided).
- **Validation and release are separate workflows.** `fork-ci` decides validity; `fork-release`
  acts on it. See [Releasing from `fork/dev`](#releasing-from-forkdev).
- **Upstream is merged directly into `fork/dev`**, not imported as a tree delta from a rebuilt
  provenance stack. `fork/dev` therefore carries upstream's real commits and "commits behind
  upstream" reads true. See [Synchronizing Upstream](#synchronizing-upstream-into-forkdev).
- **The stack and overlay tooling is removed.** Nothing rebuilds `fork/base`, `fork/tim` or
  `fork/candidates` on an upstream update.

## Open Decisions

None of these block anything currently running:

- Release cadence per target. Everything is immediate today; lagged promotion is available.
- Frequency of upstream synchronization.
- Whether identity, Discord, or VS Code needs a stable subsystem staging branch.
- Whether clean downstream projection is ever built, and if so on what trigger.
- Naming of the generated clean branches.
- Exact rules for mapping shared-package changes to downstream consumers.
- When to delete `fork/changes` and `fork/integration`, and whether to close the three
  provenance PRs (#255, #1, #27) now that nothing rebuilds their branches.

## The Operating Principle

> Rebase external provenance; squash stable product development onto `fork/dev`; release exact green
> `fork/dev` checkpoints; generate clean downstream history separately — and only when it is
> actually needed.

The cutover took a single day: `fork/dev` cut from the green `fork/integration` tip, overlays
drained, the ops deploy branch flipped, and releases running from exact green SHAs. It removed daily
rebases from contributor and release workflows and removed routine label administration, while
preserving the ability to produce a clean, auditable downstream history later if it is ever worth the
cost.
