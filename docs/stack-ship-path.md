# Stack ship path (planned operating model)

**Goal:** make a product change, merge it, get a green `fork/integration`, and deploy — **without**
waiting for a full upstream / Tim / candidates restack.

**Nothing in the runnable stack is optional.** Every layer below is required for a complete
deploy tip. The only choice is _when_ you advance provenance layers (slow path), not whether
overlays or Tim/candidates “count.”

```text
pingdotgg/t3code:main                 required mirror
  └── fork/base                       required fork-only CI / repo plumbing
        └── fork/tim                  required Tim Smart integrations
              └── fork/candidates     required selected open upstream PRs
                    └── fork/changes  required shared downstream product
                          ├── ordinary feature PRs     → merge into fork/changes
                          ├── registered overlays      required client layers (parallel drafts)
                          │     (desktop, discord, vscode, … as listed in the manifest)
                          └── compose → fork/integration   required runnable / deploy tip
                                        = fork/changes + every registered overlay in order
```

| Layer                          | Required? | What “required” means                                                                                                                                                           |
| ------------------------------ | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`                         | **Yes**   | Upstream mirror only.                                                                                                                                                           |
| `fork/base`                    | **Yes**   | Fork-only repo plumbing (Fork CI, non-Blacksmith runners). Parent of Tim.                                                                                                       |
| `fork/tim` / `fork/candidates` | **Yes**   | Permanent provenance parents of product. Rebuild on the **slow path** only.                                                                                                     |
| `fork/changes`                 | **Yes**   | Shared product default branch. Ordinary features merge here.                                                                                                                    |
| **Every registered overlay**   | **Yes**   | If it is in `integrationOverlays`, it **must** be based on current `fork/changes` and included in every compose of `fork/integration`. Skipping an overlay is not a valid ship. |
| `fork/integration`             | **Yes**   | Only tip you run and deploy. Never a feature/import branch.                                                                                                                     |

Overlays are **not** “nice-to-have clients.” They are long-lived product slices kept out of
`fork/changes` so shared history stays clean — but the **runnable product always includes them**.

This document is the **planned** split between a **fast ship path** and a **slow layer-rebuild path**.
It supersedes the older assumption that every merge to `fork/changes` must run the full
`Rebase fork PR stack` mega-job.

Related: [fork-stack.md](./fork-stack.md) (topology, overlays, conflict resolutions),
[stack-history-rewrite.md](./stack-history-rewrite.md) (history hygiene).

---

## Policy in one line

> **Merging to `fork/changes` and composing `fork/integration` must not require a successful full
> stack rewrite.** Full stack rewrite (main → base → tim → candidates → changes → rebase every
> overlay → compose) is a separate, stop-the-line operation.  
> **Composing without every registered overlay rebased onto current `fork/changes` is incomplete.**

---

## Where you branch (and a rejected alternative)

### Current rule (keep)

```text
ordinary shared work  → branch from fork/changes → PR base fork/changes
overlay-owned work    → branch from that overlay  → PR base = overlay branch
run / deploy          → always fork/integration (compose)
```

Why this graph stays simple:

- One merge target for shared product (`fork/changes`).
- Overlays stay **parallel** (not stacked on each other), rebased when `fork/changes` moves.
- Compose is a pure function: `changes + ordered overlay tips → integration`.
- Ordinary PRs do not encode multi-parent dependencies on desktop+discord+vscode.

### Alternative that feels nicer (not adopted)

**Branch off `fork/integration`**, develop against the full product tree, then somehow land the PR
“on top of changes → overlays (aka integration).”

Why it is attractive:

- Local and CI see Discord / desktop / VS Code + shared code without a separate compose step.
- Matches “the product is integration” intuition.

Why we **do not** make this the default model:

1. **Merge target ambiguity.** GitHub PRs have one base. Landing into “the full product” either
   means merging into a permanent open overlay/integration PR forest, or inventing multi-base
   merges. That is hard to automate and easy to get wrong.
2. **Dependency explosion.** A change that touches shared code _and_ two clients becomes “this PR
   depends on two other open PRs.” Stacks of N open PRs with cross edges are confusing for humans
   and agents, and `fork:stack update` / rebase automation gets brittle.
3. **Permanent open PR tax.** Integration-as-base works only if every overlay (and often
   integration itself) stays a permanent open PR surface. That is already painful for overlays;
   expanding it to every feature is worse.
4. **Compose already defines integration.** The shipable tree is reproducible from manifest
   branches. Branching from a composed tip couples you to a generated history and invites
   tip-only fixes on integration.

If we ever revisit this, the design bar is: **one clear base per PR**, **no multi-parent feature
graphs**, and **integration remains compose-generated** (not a merge destination for ordinary
features). Until then: **branch from `fork/changes` (or the owning overlay), compose for the full
product.**

---

## Two paths

### Fast path — every day (features / fixes)

Unblocks “I just want to ship.” Still ends with **full** integration (all required overlays).

```text
pnpm fork:stack start my-fix     # from fork/changes
  → implement + local gates (vp check, typecheck, focused tests)
  → PR → fork/changes → merge
  → Compose fork integration workflow (on merge only, not on push):
       1. auto-rebase every registered overlay onto current fork/changes
       2. compose overlays onto fork/changes → push fork/integration
       3. dispatch Fork CI on that SHA
  → smart poller deploys (if enabled)
```

**Does not** rebuild `main`, `fork/tim`, or `fork/candidates`.  
**Does not** run on force-pushes / tip rebases of product layers (those are manual compose).  
**Does not** auto-rebase the entire open _feature_ PR forest (only **registered overlays** on merge).  
**Does not** wait for a mega restack job.  
**Does** require clean overlay rebases — real product conflicts still fail the job (fix that overlay, re-run compose).

Layer PR status is **Fork CI only** (Check / Test / Mobile / Release Smoke). Compose is not a
layer quality signal and must not be a required check on permanent `fork/*` drafts.

#### Compose (integration)

After a PR **merges** into `fork/changes` or a registered overlay base, **Compose fork integration**
runs. Direct pushes to those tips do **not** compose — use `workflow_dispatch` or local scripts.
Locally:

```sh
# From a clean checkout of fork/changes (with push credentials for stack branches)
node scripts/rebase-integration-overlays.ts          # no-op when already based
node scripts/compose-integration-overlays.ts --push
gh workflow run "Fork CI" --repo patroza/t3code --ref fork/integration
```

Or one shot:

```sh
gh workflow run compose-integration.yml --repo patroza/t3code --ref fork/changes
```

Compose pipeline:

1. **Auto-rebase overlays** (`scripts/rebase-integration-overlays.ts`): for each registered
   overlay not based on current `fork/changes`, `git rebase --onto` using the merge-base with the
   new tip, then force-with-lease push. Skips when already based.
2. **Compose** (`scripts/compose-integration-overlays.ts`): current `fork/changes` + every
   overlay tip (manifest order) → `fork/integration` (lockfile regen as needed).
3. **Dispatch Fork CI** on the composed tip.

If an overlay **conflicts** during auto-rebase, the job fails with the branch + paths. Fix that
overlay tip (or add a durable product merge), push it based on current `fork/changes`, then re-run
compose — do not leave the overlay stale and expect a partial ship.

Do **not** rebuild Tim/candidates to fix one overlay. Do **not** ship integration with a missing
or stale registered overlay.

#### Feature PR maintenance (handoff hygiene, not the ship gate)

Keeping open _feature_ PRs rebased onto `fork/changes` is handoff work for that PR:

```sh
pnpm fork:stack update --push          # current branch / its PR
pnpm fork:stack update --push <pr>     # explicit PR
pnpm fork:stack pull                   # after remote rewrote your branch
```

Global “rebase every open feature PR on every parent move” is **not** part of the fast path.
Keeping **registered overlays** on current `fork/changes` **is** part of the ship path whenever
you compose.

---

### Slow path — when parents must move (planned)

Runs when you **choose** to take new upstream, Tim imports, or candidate imports — not on every
product merge.

**GitHub Actions:** the `Rebase fork PR stack` workflow stays **`disabled_manually`**. Do **not**
enable it and do **not** `gh workflow run rebase-pr-stack.yml`. Restacks are **operator/local only**:

```sh
export GH_TOKEN="$(gh auth token)"
# from a checkout of fork/changes with write access to stack branches:
node scripts/rebase-pr-stack.ts sync --dry-run   # inspect first
node scripts/rebase-pr-stack.ts sync --push      # only when intentional
# or rebuild layers by hand, green gate each tip before the next child
```

```text
mirror main  (exact pingdotgg/t3code:main)
  → rebuild fork/base       fork-only CI plumbing green on tip (stop the line)
  → rebuild fork/tim        full local CI green on tip (stop the line)
  → rebuild fork/candidates full local CI green on tip
  → rebuild fork/changes    full local CI green on tip
  → rebase each registered overlay onto new fork/changes (each required)
  → compose fork/integration
  → Fork CI + deploy
```

Rules:

1. **One red layer blocks the next.** Never stack “green later.” Overlays and integration are
   layers in that sense after `fork/changes` is green.
2. Prefer **compose** for `fork/integration` after rewrites; do not rebase an old integration tip
   onto rewritten history.
3. Record durable `conflictResolutions` in `.github/pr-stack.json` when the same path always takes
   the same side — but **never** whole-file `ours`/`theirs` on shared product paths
   (`ChatView`, VCS drivers, contracts RPC, etc.). Those need a real 3-way product merge.
4. Product-facing recovery belongs in product-named commits, not permanent tip-only `fix(stack)`.
5. Before green-gating Tim or candidates, rewrite every new or changed non-upstream migration into
   the fork migration manifest and ledger. Preserve upstream migration IDs/names exactly; see
   [fork-stack.md](./fork-stack.md#migration-namespaces-during-provenance-imports).

While a slow path is in flight, the **default** is still: do not block unrelated product PRs unless
you intentionally freeze merges for a cutover window.

---

## Current automation state

| Job                          | Intended role                                        | Status                                                                                                                                                                     |
| ---------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compose fork integration** | Integration tip from changes + **all** overlays      | **Active** — merge into `fork/changes` / overlay bases, or `workflow_dispatch`. **No push trigger.** Not a required layer check.                                           |
| **Fork CI**                  | Green gate on product PR tips / composed integration | **Active** — only quality signal for permanent layer drafts (incl. **tim** / **candidates** via dispatch or PR base)                                                       |
| **Upstream CI** (`ci.yml`)   | Upstream Blacksmith runners                          | **`disabled_manually` — leave it that way.** No Blacksmith on this fork; enabling it leaves Tim/candidates checks queued forever.                                          |
| **Rebase fork PR stack**     | Full layer rebuild + PR cascade                      | **`disabled_manually` in GitHub Actions — leave it that way.** Do **not** enable or dispatch this workflow. Slow-path restacks are **local only** (see slow path section). |
| **Smart integration poller** | Deploy CI-approved integration SHA                   | On when fleet should track green integration                                                                                                                               |

**Do not re-enable `Rebase fork PR stack`.** Operators who need a full upstream / Tim / candidates
rewrite run `node scripts/rebase-pr-stack.ts sync --push` (or equivalent) **locally** with appropriate
credentials, layer by layer, green gates first. GitHub Actions must not auto-restack the provenance
stack on pushes to `main` / `fork/tim` / `fork/candidates`.

---

## Overlays (required client layers)

Registered in `.github/pr-stack.json` → `integrationOverlays`.

| Rule                      | Detail                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Required for integration? | **Yes** — every registered overlay must be rebased onto current `fork/changes` and composed                             |
| Base                      | Always current `fork/changes` (never based on each other)                                                               |
| Source of truth           | **Branch tip** in the manifest; draft PR is for review/tracking                                                         |
| Labels                    | **`OVERLAY` required** on every permanent draft overlay PR                                                              |
| Draft                     | Draft = “do not merge into `fork/changes`”; health CI can still be green                                                |
| Closed by mistake         | **Fix branch → reopen same PR** first; new PR only if reopen fails (then label OVERLAY + update `pr-stack.json` number) |
| Tip repairs               | **Amend / rewrite** the bad commit on the overlay tip when stack bypass is available; avoid tip-only recovery noise     |
| Ship impact               | Behind overlay ⇒ rebase that overlay + compose; do not restack Tim; do not skip the overlay                             |

**Closed permanent drafts:** agents must **not** default to “open PR #N+1”. Reopen the registered
number after the branch tip is healthy. New overlay PRs require **`OVERLAY`** and a same-change
manifest number update. Full procedure: [fork-stack.md](./fork-stack.md) (“Permanent draft PRs”).

**Planned automation fix:** compose/stack tooling should key off **branch names + label**, not
“PR must be open.” Closed overlay PRs must not brick the ship path. Until tooling is fixed, keep
registered overlay PRs **open** (draft) so validation does not fail mid-ship.

---

## Layer tip repairs (prefer amend)

When fixing **`fork/changes`** or a **registered overlay** tip yourself (not via a normal feature
PR merge):

| Do                                                    | Don't                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Amend or fold into the commit that introduced the bug | Stack forever-forward `style:` / `fix(stack):` tip commits when rewrite is allowed |
| Force-with-lease the layer; rebase dependents         | Leave format/typecheck debt for “CI will catch it”                                 |
| Use a child PR when the work is a real feature        | Rewrite someone else's open feature PR tip without coordination                    |

Feature landings still use new commits and merges. Amend is for **operator/agent maintenance** of
shared stack tips. See [fork-stack.md](./fork-stack.md) (“Fixing layer tips — prefer amend”).

## Lockfiles (no tip-only product lock debt)

| Layer                                 | Rule                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Feature PR / commit on `fork/changes` | If any workspace `package.json` changes, the **same** commit/PR updates `pnpm-lock.yaml` (`CI= pnpm install`). Frozen install must pass.                                     |
| Tim / candidates replay               | Commits that change manifests regenerate lock **in that commit** during a planned rebuild.                                                                                   |
| Overlay tips                          | Self-consistent for that overlay’s packages; lock-only commits may diverge by design.                                                                                        |
| Integration compose                   | Compose skips lock-only overlay commits and may commit **one** generated `chore(integration): regenerate pnpm-lock.yaml…` as a **compose artifact**, not as product history. |

Tip-only lock fixes on **product** layers are process failures. Generated integration lock after multi-overlay compose is acceptable when product and overlay PRs were already self-consistent.

---

## Day-to-day checklist (agents and humans)

### Ship a fix/feature

1. `pnpm fork:stack start <branch>` from up-to-date `fork/changes` (not from integration).
2. Implement; run focused tests + package typecheck while iterating.
3. Before ready handoff: root `vp check` + full monorepo typecheck (see AGENTS.md).
4. Open/update PR against **`fork/changes` only** (never `main`, never `fork/integration` as merge base for ordinary features).
5. Merge when green.
6. Rebase **every** registered overlay onto the new `fork/changes` tip if needed.
7. Compose integration + dispatch Fork CI (or rely on compose-on-merge when enabled).
8. Confirm poller/deploy only if runtime-affecting and CI succeeded.

### Overlay-only change

1. Work on the overlay branch via a **child PR targeting the overlay** (preferred), or on the
   overlay tip only when using an intentional bypass actor for stack maintenance.
2. Do **not** duplicate the change into `fork/changes`.
3. **Same local gate as any feature PR** before ready/merge (root `vp check` + full monorepo
   typecheck + focused tests). Overlay-child bases are protected with the same required Fork CI
   checks as `fork/changes`. “Compose only ran” or “draft permanent overlay PR is green” does
   **not** mean the child tip was checked.
4. Rebase onto latest `fork/changes` if needed; merge only when Check/Test are green; compose
   **full** integration (all overlays); confirm integration CI.

### Taking new upstream / Tim / candidates

1. Schedule a **slow path** rebuild; do not mix with unrelated feature landings if avoidable.
2. Stop the line per layer; product 3-way merges for conflicts (no blind whole-file product
   `ours`/`theirs`).
3. Audit migration diffs in every imported/replayed commit. Rewrite Tim/candidate/overlay migrations
   into `ForkMigrations.ts`; upstream-only migrations remain unchanged in `Migrations.ts`.
4. Rebase **all** registered overlays; compose; CI; then resume normal fast path.

---

## Success criteria

The stack model is “good enough” when:

1. A normal product PR can merge to `fork/changes` and reach green `fork/integration` **the same day**
   without running a full main→tim→candidates rewrite.
2. That integration tip always includes **every** registered overlay on current `fork/changes`.
3. A full restack is rare, deliberate, and fully green per layer (including each overlay tip, then
   composed integration) before the next layer advances.
4. One closed overlay PR or one conflicted feature PR cannot block unrelated product deploys once
   tooling keys off branches (until then: keep overlay drafts open).
5. `fork/tim` and `fork/candidates` remain permanent required parents of product — updated on the
   slow path only.
6. We do **not** force ordinary features to branch from integration or encode multi-overlay PR
   dependencies.

---

## Implementation backlog (remaining)

Compose-on-merge is **landed**. Remaining improvements:

1. Keep **Rebase fork PR stack** **`disabled_manually` forever for automation.** Prefer local
   `node scripts/rebase-pr-stack.ts …` for slow-path rewrites. Do not re-enable the workflow for
   schedule/push, and do not treat `workflow_dispatch` as the default agent path.
2. **Overlay validation** in compose/stack scripts: branch existence + OVERLAY label;
   do not require `state=open` as a hard gate for compose.
3. **Conflict resolution policy**: forbid durable whole-file product path strategies in
   `conflictResolutions` for shared app/package sources (warn → error over time).
4. Optional later: local tooling helpers for per-layer rebuild (`tim` / `candidates` / `changes`)
   with stop-the-line gates — still not a GitHub Actions mega-restack.
