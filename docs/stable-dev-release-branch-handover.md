# Stable Development and Release Branch Handover

## Status

Design proposal. This document describes a migration away from using the continuously rebased fork
stack as the daily contributor and release path.

The intended outcome is:

- Contributors work against a stable branch whose history is never rewritten.
- A green merge can be released immediately or according to a configurable cadence.
- The useful upstream, base, Tim, and candidate provenance layers remain clean and rebased.
- Routine work does not require contributors to label desktop, mobile, server, or other affected
  clients manually.
- Clean downstream history remains available as generated output rather than an authoring surface.

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

fork/dev checkpoint
  -> fork/changes-clean
  -> fork/integration-clean    periodic generated projection, never a PR base
```

## Branch Responsibilities

| Branch                   | Rewritten           | Contributor target | Release source | Purpose                                     |
| ------------------------ | ------------------- | ------------------ | -------------- | ------------------------------------------- |
| `main`                   | Yes, mirror-managed | No                 | No             | Exact upstream mirror                       |
| `fork/base`              | Yes                 | No                 | No             | Fork repository and CI infrastructure       |
| `fork/tim`               | Yes                 | No                 | No             | Selected Tim imports with provenance        |
| `fork/candidates`        | Yes                 | No                 | No             | Selected unmerged upstream candidates       |
| `fork/dev`               | Never               | Yes                | Yes            | Canonical complete downstream product       |
| `fork/changes-clean`     | Yes                 | No                 | Optional       | Curated downstream projection               |
| `fork/integration-clean` | Yes                 | No                 | Optional/audit | Clean composed output matching a checkpoint |

The clean branch names are placeholders. Existing names may be retained if their generated nature
is made unmistakable and tooling prevents contributors from targeting them.

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
- Generated clean branches are output only and may be rewritten safely.
- Generated branches are never merged back into `fork/dev`.
- For a selected checkpoint, the final clean projection must reproduce the checkpoint's product
  tree, apart from narrowly documented generated metadata.

```text
tree(fork/integration-clean) == tree(tagged fork/dev checkpoint)
```

## Synchronizing the Rebased Stack into `fork/dev`

Rewritten provenance branches must not be repeatedly merged into `fork/dev`. After a rebase, their
commits have new identities; merging the rewritten tip would duplicate history and produce avoidable
conflicts.

Instead, synchronize the net tree change.

Assume:

- `C1` is the `fork/candidates` tree currently incorporated into `fork/dev`.
- `C2` is the latest rebuilt and verified `fork/candidates` tree.

The synchronization process should:

1. Create a sync branch from `fork/dev`.
2. Calculate the tree delta from `C1` to `C2`.
3. Apply that delta to the sync branch.
4. Resolve integration conflicts against the current `fork/dev` product tree.
5. Run the full required checks.
6. Open a normal PR into `fork/dev`.
7. Merge it without rewriting `fork/dev`.
8. Record `C2` as the newly imported provenance checkpoint.

The PR should be recognizable without requiring daily contributor metadata, for example:

```text
sync(provenance): import upstream stack C1..C2
```

The imported checkpoint may be recorded in an immutable tag or a small machine-owned state file:

```json
{
  "importedCandidatesCommit": "<commit>",
  "importedCandidatesTree": "<tree>",
  "importedUpstreamCommit": "<commit>"
}
```

This is stack synchronization state, not a manual product ledger.

## Daily Contributor Workflow

The normal path becomes:

1. Create a feature branch from `fork/dev`.
2. Open a PR against `fork/dev`.
3. Run the mandatory local validation.
4. Run GitHub CI for the exact PR and merge tip.
5. Merge using the selected stable-history policy.
6. Release immediately or include the merge in the next release cadence.

No restack or overlay composition is required for an ordinary feature or fix.

Squash merges are a reasonable default because they give each GitHub PR one stable commit on
`fork/dev`. Merge commits can remain available where preserving a dependent series is valuable.

## Identity, Discord, and VS Code

Identity, Discord, and VS Code remain meaningful ownership areas, but they do not necessarily need
permanent composition overlays.

### Preferred model

Their feature PRs target `fork/dev` directly. Ownership and validation are inferred from paths and
dependency impact:

- Discord's separate application/package directories naturally select Discord checks and owners.
- VS Code's separate extension directories naturally select VS Code checks and owners.
- Identity-owned paths and shared integration points select identity checks and owners.
- Shared package changes expand validation to affected consumers.

Use path-based workflow filters and `CODEOWNERS` instead of requiring contributors to apply client
labels.

### Optional subsystem staging branches

If one of these areas genuinely needs independent staging, it may use a stable branch such as:

```text
fork/discord-dev
fork/vscode-dev
fork/identity-dev
```

These branches must also never be rebased. Work is merged into `fork/dev`, and `fork/dev` is merged
back afterward so the subsystem branch stays current.

This adds merge topology and administration, so it should only be introduced where separate staging
provides a concrete benefit. Clear folders alone are not sufficient justification.

## Ordinary Cross-Cutting Features

Features such as the desktop URL-handler enhancement should be ordinary commits or squash-merged
PRs on `fork/dev`, not permanent layers.

For example:

```text
feat(desktop): support remote URL handling
```

The changed files determine validation and release scope. A dedicated layer is justified only when
work has independent external provenance or must remain independently staged—not simply because it
is identifiable as a feature.

## Inferring Validation and Release Scope

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

Path rules should be generated from workspace ownership/dependency data where practical. Unknown or
ambiguous shared paths should fail safely by selecting broader checks, not by requiring labels.

Labels remain appropriate only for exceptional intent that cannot be inferred from code:

- Explicitly excluding a change from a clean projection.
- Associating a repair with an earlier feature for history folding.
- Recording an unusual external import.
- Requesting a special release behavior.

## GitHub PRs as the Development Ledger

GitHub PR history is the primary daily ledger. Do not create a second manifest containing every
normal contributor PR.

The projection process can use:

- Merge order and timestamps.
- Stable squash or merge commits on `fork/dev`.
- Changed paths.
- PR relationships and referenced issues.
- External provenance recorded on import PRs.
- Checkpoint tags defining the projection interval.

Explicit metadata is required only when the work cannot speak for itself.

### External imports

Tim and candidate import PRs should record immutable source information:

```text
Source-Repository: <owner/repository>
Source-PR: <number>
Source-SHA: <commit>
Fork-Layer: tim|candidate
```

### Folding later repairs

A repair that should be folded into an earlier clean-history feature may record:

```text
Projection-Fold-Into: <fork PR number>
```

This is exceptional projection metadata, not a label required on normal work.

### Minimal manifest

A small manifest remains useful for machine policy that GitHub cannot reliably infer:

- Layer ordering.
- External import sources.
- Persistent conflict-resolution rules.
- Explicit exclusions.
- Required ordering constraints.
- Fix-to-feature folding overrides.
- Exceptional commits that did not originate in a PR.

It should not duplicate the GitHub PR overview.

## Release Workflow

`fork/dev` supports multiple release policies without changing the branch model.

### Immediate releases

After a merge:

1. Obtain or run CI for the exact resulting `fork/dev` SHA.
2. Infer affected release targets from the previous approved SHA and the new SHA.
3. Dispatch releases for affected targets.
4. Record the outcome independently for each target.

This is suitable for urgent bot, server, or desktop fixes.

### Lagged releases

Merges may instead accumulate and be promoted:

- After a debounce period.
- Every few hours.
- Daily.
- At a manually selected checkpoint.
- On different schedules for different products.

For example, bot/server releases can be frequent while desktop or mobile uses a slower promotion
cadence. These are release-policy decisions and do not require additional integration branches.

### Checkpoints

Approved releases and clean projections should reference immutable `fork/dev` checkpoints, for
example:

```text
fork-dev/2026-08-06.1
fork-dev/2026-08-06.2
```

Each deployment record should include:

- `fork/dev` SHA.
- CI run and conclusion.
- Calculated change scope.
- Bot deployment status.
- Server deployment status.
- Desktop build/publication status.
- Mobile build/publication status.

A partial multi-target release must not be represented as completely deployed.

## Periodic Clean Downstream Projection

Clean downstream history can be generated monthly, twice monthly, before major releases, or on
demand. It is not part of the routine release critical path.

### Inputs

- Latest selected upstream commit.
- Rebuilt and verified `fork/base`, `fork/tim`, and `fork/candidates`.
- A tagged, green `fork/dev` checkpoint.
- GitHub PRs merged between projection checkpoints.
- Exceptional projection metadata and conflict policies.

### Process

1. Select and tag a green `fork/dev` checkpoint.
2. Update the upstream mirror.
3. Rebuild and verify `fork/base`.
4. Rebuild and verify `fork/tim`.
5. Rebuild and verify `fork/candidates`.
6. Select downstream PRs represented in the checkpoint.
7. Exclude provenance-sync commits because their content is already represented below.
8. Replay downstream features into `fork/changes-clean`.
9. Fold explicitly linked repairs into their owning feature commits.
10. Generate any still-required client projections.
11. Compose `fork/integration-clean`.
12. Run the complete per-layer gate in stop-the-line order.
13. Verify tree equivalence with the selected `fork/dev` checkpoint.
14. Publish generated branches only after all checks pass.

### Failure behavior

A projection failure:

- Blocks publication of the generated clean stack.
- Does not rewrite or block `fork/dev`.
- Does not block unrelated releases from an already-green `fork/dev` SHA.
- Produces an actionable report identifying the PR, layer, commit, and conflicting paths.

## Tree-Equivalence Verification

The clean projection must prove it did not drop downstream behavior.

At minimum, compare the selected trees:

```bash
git diff --exit-code <fork-dev-checkpoint> <fork-integration-clean>
```

Any expected differences must be narrowly documented and machine-verifiable. Do not accept broad
path exclusions.

The projection gate should additionally verify:

- Package manifest and lockfile consistency.
- Migration namespace integrity.
- Web and mobile fork-surface existence tests.
- Server and bot behavioral tests.
- Desktop build and preload verification.
- Identity, Discord, and VS Code behavior.
- Release smoke tests.

## CI Responsibilities

### PRs targeting `fork/dev`

Run the complete product gate appropriate to the inferred impact:

- Formatting and lint.
- Full monorepo typecheck.
- Unit and behavior tests.
- Desktop build and preload checks when affected.
- Mobile native static analysis when affected.
- Release smoke checks when affected.
- Conservative full validation for ambiguous shared changes.

### Merges into `fork/dev`

Release only the exact merge SHA after its required checks pass. A green PR tip is not sufficient if
the resulting merge SHA differs or the base moved.

### Rebased provenance and clean projection layers

Retain the existing full, stop-the-line per-layer gate:

```text
main
  -> fork/base
  -> fork/tim
  -> fork/candidates
  -> fork/changes-clean
  -> optional generated projections
  -> fork/integration-clean
```

This expensive process is appropriate for periodic provenance maintenance. It should not sit in the
path of every routine product release.

## Migration Plan

### Phase 1: Establish `fork/dev`

1. Create `fork/dev` from the current green `fork/integration` tip.
2. Prove the initial trees are identical.
3. Record the incorporated `fork/candidates` checkpoint.
4. Protect `fork/dev` against force-pushes and deletion.
5. Configure required checks and merge policy.
6. Make `fork/dev` the default base for ordinary contributor PRs.
7. Keep the old release path temporarily as a fallback.

### Phase 2: Release from `fork/dev`

1. Update release workflows to accept an exact green `fork/dev` SHA.
2. Implement path/dependency-based scope classification.
3. Track per-target release outcomes.
4. Add immutable release/checkpoint records.
5. Exercise bot, server, desktop, and mobile paths.
6. Stop requiring full-stack composition for routine releases after validation.

### Phase 3: Simplify overlays

1. Route new identity, Discord, and VS Code PRs directly to `fork/dev` unless independent staging is
   demonstrably required.
2. Move ownership to `CODEOWNERS` and path-based CI.
3. Land current overlay content into `fork/dev` through reviewed migration PRs.
4. Retire permanent composition overlays once no open work depends on them.
5. Convert small cross-cutting overlays, including the desktop URL handler, into ordinary stable
   feature history.

### Phase 4: Automate provenance synchronization

1. Persist the last imported candidates commit and tree.
2. Build the `C1..C2` tree-delta sync branch automatically.
3. Open a reviewed PR into `fork/dev`.
4. Run the complete product gate.
5. Update the checkpoint only after the PR merges.
6. Never merge a rewritten provenance branch directly into `fork/dev`.

### Phase 5: Automate clean projection

1. Query GitHub PRs between checkpoint tags.
2. Infer ordinary changes from their commits and paths.
3. Read explicit metadata only for imports and projection exceptions.
4. Replay changes into clean layers.
5. Fold explicitly related repairs.
6. Apply durable conflict policies.
7. Verify every rewritten layer.
8. Prove final tree equivalence.
9. Publish generated branches.

### Phase 6: Retire the old critical path

After the new release and projection workflows are proven:

- Stop targeting `fork/changes` with contributor PRs.
- Stop composing permanent overlays after every product merge.
- Mark generated branches clearly as non-authoring surfaces.
- Keep clean reconstruction available without coupling it to normal releases.

## Operational Rules

1. Never force-push or rebase `fork/dev`.
2. Never merge generated projection branches into `fork/dev`.
3. Never merge a rewritten provenance tip directly into `fork/dev`; import its tree delta.
4. Never require a clean projection rebuild to ship an unrelated urgent fix.
5. Never release an untested `fork/dev` SHA.
6. Every ordinary product change enters through a GitHub PR.
7. Daily contributors do not manually classify affected clients when paths and dependencies can do
   so.
8. External imports record immutable source provenance.
9. Projection exceptions are explicit and rare.
10. A generated integration is not successful until it matches its selected `fork/dev` checkpoint.

## Open Decisions

These decisions can be made independently after the branch topology is accepted:

- Immediate, debounced, scheduled, or manual release cadence for each target.
- Squash-only versus mixed merge policy on `fork/dev`.
- Frequency of upstream/provenance synchronization.
- Frequency of clean downstream projection.
- Whether identity, Discord, or VS Code needs a stable subsystem staging branch.
- Whether clean projection is mandatory for major releases or purely an audit/upstreaming artifact.
- Naming of the generated clean branches.
- Exact rules for mapping shared-package changes to downstream consumers.

## Recommended Decision

Adopt the following operating principle:

> Rebase external provenance; merge stable product development; release exact green `fork/dev`
> checkpoints; generate clean downstream history separately.

This retains the valuable structure of `main -> base -> Tim -> candidates`, removes daily rebases
from contributor and release workflows, avoids routine label administration, and preserves the
ability to produce a clean, auditable downstream history when it is actually needed.
