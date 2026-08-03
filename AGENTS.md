# AGENTS.md

## Downstream fork branches and pull requests

Read [docs/fork-stack.md](./docs/fork-stack.md) before creating, rebasing, merging, or retargeting
branches.

Day-to-day ship path (compose, not restack): [docs/stack-ship-path.md](./docs/stack-ship-path.md).

- Before the documented one-time cutover, implementation PRs continue to target `main`.
- After cutover, `main` is an upstream mirror. Never merge downstream fork work into it.
- Update `main` only via a **local** provenance restack (`node scripts/rebase-pr-stack.ts sync
--push` or hand-applied layer rewrites), never via GitHub's **Sync fork** button, a PR into
  `main`, or a casual force-push. The GitHub Actions workflow **Rebase fork PR stack** is
  **`disabled_manually` — leave it disabled.** Do not enable or dispatch it. Local restacks that
  must move protected tips use the repository-scoped `FORK_STACK_DEPLOY_KEY` (or an allowed bypass
  actor) only for that intentional rewrite; agents must never print or reuse that credential.
- **`fork/base`** sits on upstream `main` and holds **only** fork repository plumbing (GitHub-hosted
  Fork CI, Blacksmith-free `ci.yml` runners, `docs/fork-base.md`). No Tim, candidates, or product.
  Permanent draft PR against `main`. Restacks rebuild base first, then Tim → candidates → changes.
- `fork/tim` contains only selected Tim Smart integrations above **`fork/base`**. `fork/candidates`
  contains selected open upstream PRs that we run before upstream accepts them, one provenance
  commit per source PR, above Tim. The permanent `fork/changes` PR is based on `fork/candidates`,
  contains only our downstream layer, remains open, and is the GitHub/T3 default branch.
- Long-lived upstreamable features may be registered as `integrationOverlays`. They remain parallel
  draft PRs based on `fork/changes`; `fork/integration` composes them in manifest order. Never merge
  a registered overlay directly. Update its branch, or use
  `pnpm fork:stack overlay-start <pr> <branch>` and target the child PR at the overlay branch.
  Draft state blocks merging while normal green CI remains meaningful. Permanent overlay PRs must
  carry the **`OVERLAY`** label.
- **Closed permanent draft PRs (overlays / managed stack PRs):** do **not** open a replacement PR
  as the first reaction. (1) Fix the branch tip if needed (rebase onto the intended base, force-
  with-lease). (2) **`gh pr reopen <n>`** the **same** PR number and restore draft + **`OVERLAY`**
  (for overlays). (3) Only if GitHub refuses reopen, create a new draft PR, apply **`OVERLAY`**, and
  update `.github/pr-stack.json` `integrationOverlays[].number` in the same change. Never leave the
  manifest pointing at a closed PR.
- **Fixing `fork/changes` or an overlay tip:** prefer **amending / rewriting the commit that
  introduced the bug** (or folding into the existing product/reapply commit), then force-with-lease
  the layer tip. Do **not** stack permanent tip-only `fix(…)` / `style(…)` recovery commits when the
  tip is still operator-owned stack surface and history rewrite is allowed. New tip commits are OK
  for ordinary **feature** work that lands via PR merge into the layer.
- Before targeting `fork/changes`, inspect `.github/client-overlay-ownership.json` or run
  `pnpm fork:overlay-owner <changed-path> [changed-path...]`. Changes owned by an extracted client
  must update that draft overlay (or a child PR targeting it), not duplicate its implementation in
  `fork/changes`. Read [docs/client-overlays.md](./docs/client-overlays.md) for mixed shared/client
  changes and extraction cutovers.
- Start new work with `pnpm fork:stack start <branch>` and open the PR against `fork/changes`.
  Ordinary feature/import PRs are not added to `.github/pr-stack.json`; they enter the runnable fork
  only after being reviewed and merged into `fork/changes`.
- **Never open implementation PRs against `main`.** `main` is the upstream mirror; GitHub will
  report conflicts and a huge unrelated diff. Always base and retarget feature PRs on `fork/changes`.
- Before handoff (and whenever a PR is CONFLICTING / behind), run
  `pnpm fork:stack update --push` (or `pnpm fork:stack update --push <pr-number>`). That rebases or
  replays the feature commits onto the PR's intended parent (`fork/changes` for ordinary features,
  or the current parent branch for dependent/overlay-child PRs), retargets only an invalid base, and
  force-with-lease pushes so the PR stays mergeable.
- After automation rebases your branch (or `fork/changes`), refresh a local checkout with
  `pnpm fork:stack pull`. It hard-resets to remote when local commits are patch-equivalent, and only
  rebases when you have unique unpushed work.
- Independent features use parallel PRs based on `fork/changes`. Chain PRs only when one change
  genuinely depends on another, and merge that chain bottom-up.
- Treat external forks and open upstream PRs as selective import sources. Tim Smart imports land as
  one reviewed commit per source PR on `fork/tim`; selected unmerged upstream work lands as one
  reviewed commit per source PR on `fork/candidates`; our adaptations land separately on
  `fork/changes`. Cherry-pick only wanted commits, explicitly document imported, adapted, and
  excluded pieces, and never merge a source branch wholesale.
- Run and deploy from `fork/integration`, never from a temporary feature or import branch.
- All features must land in `fork/changes`, including upstreamable work. After its downstream PR
  merges, use `pnpm fork:stack promote <downstream-pr> <upstream-branch>` to extract a clean
  projection onto
  upstream `main`. Use `adopt` only for work that began upstream-first, and `demote` to close an
  upstream projection without removing the canonical downstream implementation.

### Automatic integration and deployment

- Opening or updating a PR runs CI but does not deploy.
- **Layer status = Fork CI only.** Permanent `fork/*` / overlay draft PRs must look green or red
  solely from **Check**, **Test**, **Mobile Native Static Analysis**, and **Release Smoke**
  (`.github/workflows/fork-ci.yml`). **Compose fork integration** is an integration rebuild, not a
  product-layer quality gate — do **not** add it (or any compose/rebase job) to required status
  checks for those branches.
- **Fast path (day-to-day):** `.github/workflows/compose-integration.yml` (**Compose fork
  integration**) runs **only** when:
  - a PR is **merged** into **`fork/changes`**, or
  - a PR is **merged** into a **registered overlay base** (desktop / discord / vscode / identity),
    or
  - it is started with **`workflow_dispatch`** (manual compose after a local tip rewrite).
    It does **not** run on branch **pushes** (force-push rebases, deploy-key updates, compose's own
    overlay force-with-lease). That avoids check noise on permanent draft PRs and rebase storms.
    On merge it auto-rebases every registered overlay onto current `fork/changes` (no-op when
    already based; force-with-lease on clean rebases), composes those tips into `fork/integration`,
    and dispatches **Fork CI** on the composed tip. It does **not** rewrite main/tim/candidates or
    ordinary feature PRs. Real overlay rebase conflicts fail the job with branch + paths — fix that
    overlay, then re-run compose (`workflow_dispatch` or merge again). When adding an overlay to
    `.github/pr-stack.json`, also add its branch to the `on.pull_request` base list in
    `compose-integration.yml` (and to `fork-ci.yml` PR bases).
- **Slow path (upstream / Tim / candidates):** **manual / local only.** Run
  `node scripts/rebase-pr-stack.ts sync --push` (or layer-by-layer hand restack). The Actions
  workflow **Rebase fork PR stack** stays **`disabled_manually`** — do **not** enable it, schedule
  it, or `gh workflow run` it. Pushes to `main` / `fork/tim` / `fork/candidates` must not auto-restack
  or auto-compose. Local restacks mirror `pingdotgg/t3code:main`, rebuild provenance layers with
  stop-the-line green gates, rebase overlays, then compose integration via
  `workflow_dispatch` / local compose scripts. Deploy key (if used) is only for intentional
  protected-branch force-with-lease; agents must never print or reuse it.
- Fork checks live in `.github/workflows/fork-ci.yml` and run for PRs targeting product bases (or by
  explicit `workflow_dispatch` on a branch tip). Permanent stack tips:
  - `fork/candidates` / `fork/changes` / overlays: PR base list in `fork-ci.yml`
  - `fork/tim` (PR #1 bases on `main`): green via **`workflow_dispatch --ref fork/tim`** so we do
    not attach Fork CI to every ordinary PR into `main`
  - After a restack that rewrites tips, re-dispatch Fork CI on **tim** and **candidates** when you
    need those permanent draft PRs green again
- The inherited upstream **`.github/workflows/ci.yml` (Blacksmith runners)** and `deploy-relay.yml`
  workflows are **`disabled_manually` at repository level**. This fork has no Blacksmith runners —
  if CI is left enabled, Tim/candidates jobs queue forever on `blacksmith-*-ubuntu-2404` /
  `blacksmith-*-macos-*` labels. **Do not re-enable** upstream CI or relay deploy for fork releases.
  After any accident re-enable: `gh workflow disable CI --repo <fork>`.
- Successful `fork/integration` CI classifies the complete tree diff from the previous approved
  integration tree. Runtime-affecting changes hand the exact tested SHA to the private operations
  repository; tests, documentation, agent metadata, and GitHub-only metadata do not deploy.
- Machine topology and deployment implementation belong in a separate private operations repository,
  not this repository.
- **Lockfile after stack rebase / conflict resolution (required):** never leave
  `pnpm-lock.yaml` mismatched with any `package.json` after a manual or automated layer rewrite.
  Taking `--ours` on the lockfile during conflicts is **not** finished work when `package.json`
  (or workspace package manifests) still declare different deps. Before treating the stack or a
  recovery PR as done:
  1. On the rewritten tip (usually `fork/changes`), run `CI= pnpm install --no-frozen-lockfile`
     (or `vp install` with frozen lockfile disabled) until the lockfile matches.
  2. Commit the updated `pnpm-lock.yaml` on a PR targeting `fork/changes` (or include it in the
     recovery commit that lands the rewrite).
  3. Recompose `fork/integration` if the tip already moved, then re-dispatch Fork CI.
  4. Confirm install would succeed under CI: frozen lockfile is **on** in Fork CI; failures look
     like `ERR_PNPM_OUTDATED_LOCKFILE` / "specifiers in the lockfile don't match package.json".
     Prefer regenerating the lockfile over repeatedly choosing ours/theirs on `pnpm-lock.yaml` during
     multi-commit rebases of `fork/changes`.
- **Per-layer full CI gate after stack rebase (required — stop the line):** when rebasing,
  replaying, or rewriting the stack, **every layer must pass the full local CI gate before you
  touch the next layer**. Do **not** rebase, compose, or push a child layer onto a parent that is
  still red. Do **not** “finish the stack rewrite first and green it later.”
  - Order: `fork/base` → `fork/tim` → `fork/candidates` → `fork/changes` → each integration overlay
    → compose `fork/integration` last.
  - On **each** layer tip after it is rewritten: install/lock consistent, then run the **full**
    local Fork CI gate (not only `vp check`) — see **Per-layer stack CI (stop the line)** under
    Task Completion Requirements and [docs/fork-stack.md](./docs/fork-stack.md)
    (“Per-layer full CI after stack rebase”).
  - Fix **all** failures on that layer, commit, force-with-lease push if the layer is shared, then
    and only then advance.
  - Feature / overlay-child PRs after `pnpm fork:stack update`: rebase onto the fixed parent, then
    let the automated agent ship gate validate the tip — a ready-PR push runs it, or publish with
    `pnpm pr:ready`. Only stack-layer rewrites (protected `fork/*` tips, not PR pushes) run the
    fuller per-layer manual gate below.
- **Conflict resolutions (required when stack hits conflicts):** do **not** only hand-resolve and
  resume. Update `.github/pr-stack.json` `conflictResolutions` so the next sync auto-applies the
  same side. Prefer durable `commit: "*"` + path policies; exact SHAs go stale after every rewrite.
  During rebase, `theirs` = commit being replayed, `ours` = new base. Documented in
  [docs/fork-stack.md](./docs/fork-stack.md) ("Conflict resolutions").
- **Product conflicts (shared UI / app code):** never blind whole-file `ours`/`theirs` on shared
  product paths. 3-way merge or re-apply the feature commit; run a pre/post parity check so helpers
  and tests cannot survive while JSX/wiring is dropped (see #154 remote Open in VS Code button).
  Full rules: [docs/fork-stack.md](./docs/fork-stack.md) ("Product conflicts").
- **No tip-only product `fix(stack)` recovery:** whole-file stack resolves that drop VCS/UI must be
  fixed inside the related provenance/feature commit (or one product-named commit during rewrite),
  not as permanent tip patches. Same rule for CI format/typecheck recovery on **`fork/changes` and
  overlay tips**: amend/rewrite the offending commit when you have stack push bypass; do not leave
  a forever-forward `style(docs):` / `fix(stack):` tip. Use
  `node scripts/rebase-pr-stack.ts sync --verify-each-commit` so each replayed commit typechecks.
  See [docs/fork-stack.md](./docs/fork-stack.md) (“Commit-green during stack rewrite”, “Permanent
  draft PRs”) and [docs/stack-history-rewrite.md](./docs/stack-history-rewrite.md).
- **Fork product changes need existence/behavior tests:** every user-visible or behavioral fork
  change must land with a test that fails if the surface disappears (pure helpers alone are not
  enough). Prefer pure gates + `aria-label`/`data-testid` existence, or markers in
  `apps/web/src/forkSurfaceExistence.test.ts` for chrome.
- **Integration compose lockfiles:** overlay lock commits diverge by design. Compose skips
  lockfile-only commits, defers lock-only conflicts, and regenerates one integration
  `pnpm-lock.yaml` at the end. Never push a partial `fork/integration` after a lock conflict.
  Compose seeds `node_modules` via `cp -a --reflink=auto` from a warm tree into a **home-side**
  work dir (`~/.t3/compose-work`, not tmpfs `/tmp`) before install. See
  [docs/fork-stack.md](./docs/fork-stack.md) ("Integration overlay compose and lockfiles").

## Pull requests (required handoff)

When implementation work for a user request is done (code, docs, config — not pure Q&A):

1. **Commit** the changes on a feature branch created with `pnpm fork:stack start <branch>` (from
   `fork/changes`), or `pnpm fork:stack overlay-start <pr> <branch>` for overlay-owned work.
2. **Open or update a PR** against the correct base before handing off:
   - Ordinary features → **`fork/changes`** (never `main`, never `fork/integration`).
   - Client overlay work → the **registered overlay branch** (`fork/discord`, `fork/vscode`, `fork/identity`, or
     `t3-discord/f7d37879-desktop-deeplinks`), not a duplicate of that work in `fork/changes`.
3. **Let the agent ship gate own validation** before saying “updated the PR” or finishing (see
   _Task Completion Requirements → Agent ship gate_):
   - **Push freely while the PR is a draft.** The gate is a no-op on draft / no-PR pushes — use them
     for early sharing and the GitHub Diff UI. Do **not** hand-run `vp check` / `vpr typecheck` /
     `vp run test` as routine draft validation (focused, scoped proof while iterating is still fine).
   - **Publishing always runs the ship gate** (`vp check` → `vpr typecheck` → `vp run test`), and
     only a failing gate stops it. `pnpm pr:ready` is the explicit path; raw `gh pr ready` is not
     refused — the `.tools/bin/gh` shim runs the same gate first and then lets the command through.
     Either way the checks run, so there is no way to publish around them and nothing to remember.
     The husky `pre-push` hook enforces the same gate on every push to a ready PR and fails closed
     when PR state can’t be resolved.
   - **Same gate for overlay-child PRs.** Base = overlay does **not** relax it; the gate keys off the
     PR’s ready state, not its base. Compose success or draft-lock green is **not** the gate.
   - `pnpm fork:stack update --push` (current branch) or `pnpm fork:stack update --push <pr>` to
     rebase/retarget; the ensuing push runs the ship gate when the PR is ready.
   - Confirm with `gh pr view <n> --json baseRefName,mergeable,mergeStateStatus,url`
   - `baseRefName` must be `fork/changes` for ordinary features or the intended overlay/parent
     branch for a dependent/overlay-child PR. `mergeable` should be `MERGEABLE` (CI may still be
     `UNSTABLE` while checks run).
4. **Before pushing follow-ups**, verify PR state with `gh pr view` (or equivalent):
   - If the PR is **open** → update that branch (prefer `fork:stack update --push`) and push; a ready
     PR re-runs the ship gate automatically, a draft pushes free.
   - If the PR is **merged** or **closed** → do **not** keep committing on that branch.
     Start a new branch, re-apply unmerged work, and open a **new PR** against the same intended
     base (`fork/changes` or the overlay).
5. Never assume an earlier PR in the session is still open.
6. **Never merge or request merge** (and never tell a bot to merge) a PR that has not passed the ship
   gate — publish through `pnpm pr:ready` first. GitHub required checks on `fork/changes` and every
   registered overlay base are the backstop; the ship gate is what runs first.

## Discord-originated commits (REQUIRED)

When the Discord turn includes an **Identity map** block with ready-to-paste `Co-authored-by` trailers, attribution is **mandatory**, not optional:

1. Keep the environment default **author/committer** (usually the GitHub App bot).
2. **Every** `git commit` you create for that work MUST end with those exact trailers after a blank line. Do not invent emails for unmapped people.
3. Before `git push` / opening a PR, verify with `git log -1 --format=%B` that the trailers are present on each new commit.
4. A Discord-originated commit **without** the mapped trailers is incomplete — fix it (amend if not pushed, or a follow-up commit is not enough for GitHub multi-author on already-pushed SHAs; amend/rebase when safe).

GitHub multi-author avatars (`bot & human`) come from commit trailers, not from PR body prose alone.

## Discord-originated pull requests (REQUIRED)

When Discord work produces commits (or is clearly intended to land):

0. **Always open a PR — do not wait for perfect green.** Create the PR as a **draft** as soon as the first meaningful commit gives reviewers something to inspect, and push freely while it stays draft. A missing PR while work sits only on a remote branch is incomplete handoff. **Publish only when done, with `pnpm pr:ready`** — it runs the agent ship gate, then undrafts. **Draft is for tracking, not for merging:** do not squash-merge, rebase-merge, or instruct a bot to merge a draft or any tip that has not passed the ship gate.

When opening or updating a PR from a Discord thread:

1. **Discord footer (required in the PR description).** Append this exact footer form at the end of the PR body (use the **thread starter** when known, otherwise the current requester, and that thread’s real jump link):

```md
opened by [<displayName>](discord_user_id) in chat thread **Discord** · [Thread Title](https://discord.com/channels/<guild_id>/<channel_or_thread_id>/<message_id>)
```

Prefer the thread starter’s Discord id/display name from turn context. Do not skip this because the bot _might_ patch the body later — still write it when you create the PR so the first revision is correct. The bot may also hard-append the footer when a PR URL is linked; that is a safety net, not a reason to omit it.

2. If Discord turn context lists **Linked work items** / Jira issues for the thread, include those Jira issue links in the PR description (and prefer the primary key in the title/branch when one is clear).

3. Prefer opening the PR only after commits already include the Identity map `Co-authored-by` trailers (see above).

## Task Completion Requirements

### Agent ship gate (draft-free push, gate on ready / publish)

Publish validation is **automated**. Agents do **not** hand-run the linter/typechecker/tests as a
routine pre-handoff ritual — the ship gate runs them once, at the right moment, and caches the
result. Push freely while drafting; the gate fires on ready PRs and on `pnpm pr:ready`.

**Mechanism** (`scripts/agent-pre-push.mjs`, `scripts/agent-pr-ready.mjs`, `scripts/lib/*.mjs`):

- Husky `pre-push` is the agent ship gate. It is a **no-op for humans** and only fires for coding
  agents (detected via `GROK_AGENT` / `T3_AGENT` / `AI_AGENT` / `CLAUDECODE` / Cursor / Codex env
  markers). Humans opt out per push with `SKIP_AGENT_PREPUSH=1` — **agents never set that flag** and
  never use `git push --no-verify`.
- When it runs, the gate mirrors the CI JS quality path, in order:
  1. **`vp check`** — format + lint (the Fork CI **Check** JS path)
  2. **`vpr typecheck`** — workspace TypeScript
  3. **`vp run test`** — unit tests
     Cargo, mobile native, desktop packaging, and Release Smoke stay **CI-only** — do not hand-run them
     for ordinary PR handoff.
- It **skips when the HEAD SHA is already cached** in `.run/agent-ship-gate.json`, so a push and the
  publish step never double-run for the same commit. Force with `AGENT_SHIP_GATE_FORCE=1`.

**When it runs:**

| Branch PR state        | Agent push                                |
| ---------------------- | ----------------------------------------- |
| No open PR             | **free push** (open a draft to share)     |
| **Draft** PR           | **free push** (review via GitHub Diff UI) |
| **Ready** PR           | full ship gate on every push              |
| PR state can’t resolve | full ship gate (**fail closed**)          |

This is identical for `fork/changes`, every registered overlay base (`fork/discord`, `fork/vscode`,
`fork/identity`, desktop deeplinks), and dependent / overlay-child PRs — the gate keys off the PR’s
**ready state**, not its base. Overlay Compose success or Managed-PR draft-lock green is **not** the
gate.

**Publish path:** `pnpm pr:ready` — runs the ship gate, then marks the open draft PR ready. Raw
`gh pr ready` (and the ready-for-review APIs) reach the same place: the `.tools/bin/gh` policy shim
runs the ship gate first and passes the command through when it is green, so publishing is gated
rather than forbidden and a red gate is the only thing that stops it. `AGENT_PR_SHIP=1` marks a gate
already passed — `pr:ready` sets it for its own undraft call so the gate runs once, not twice.
`.envrc` puts
`$REPO/.tools/bin` first on `PATH` so the shim wins over system `gh`, and sets `GH_REPO` to the fork
so bare `gh pr` commands target it instead of gh's upstream-parent default (explicit `--repo` still
overrides); `scripts/install-git-hooks.mjs` installs both the hooks and the shim on `prepare`.

**Agent workflow:**

- **Open the draft immediately** once a PR is in scope (user asked, or Discord/turn rules require it)
  and the first meaningful commit is useful to review. Keep committing and pushing freely while it is
  a draft — no separate validation is expected on draft pushes.
- **Publish when the work is done — do not leave a finished PR in draft.** The moment implementation
  is complete and verified, run `pnpm pr:ready` to run the ship gate and mark the PR ready; this is
  the immediate next action, before handoff notes, so full CI can start. Draft is only for
  work-in-progress. Do **not** run lint / check / typecheck / tests separately first — the gate owns
  the complete JS validation and caches the passing SHA.
- **Mid-loop feedback only:** while drafting, focused proof is fine — `vp test run <files>` for tests
  you touched, targeted lint/typecheck for the scope you changed. That is edit-loop signal, not a
  second gate.
- Fork product / UI changes still **must** ship an existence or behavior assertion that fails if the
  surface is dropped (not only pure helpers) — see `apps/web/src/forkSurfaceExistence.test.ts` and
  [docs/fork-stack.md](./docs/fork-stack.md) (“Product conflicts”). The gate’s `vp run test` then
  actually exercises it.
- Backend / contracts / runtime behavior changes **must** land with focused tests for the changed
  behavior; the gate’s `vp run test` runs them.

Pre-commit: husky runs `pnpm lint-staged` — `vp fmt` on all staged files plus `vp lint --fix` on
staged code files (format + lint on commit; typecheck and tests stay in the ship gate). If the hook
rewrites files, stage those rewrites, commit, and push again.

**Explicitly forbidden:**

- `git push --no-verify` / `git commit --no-verify`, or setting `SKIP_AGENT_PREPUSH` (human escape
  hatch only).
- Raw `gh pr ready` / the ready-for-review API to undraft — always `pnpm pr:ready`.
- Merging or requesting merge (including telling a bot to merge) a draft or any tip that has not
  passed the ship gate.
- Treating Compose, Managed-PR draft-lock, or “integration CI will catch it” as a substitute for
  publishing through the gate. If a PR’s checks panel shows only Compose / draft-lock and **no**
  Check job, it has not been through the gate — publish with `pnpm pr:ready`.
- Leaving Discord/agent work with commits but **no** PR (open a draft; pushes stay free).
- Leaving a **finished** PR in draft. Draft is for work-in-progress only; when the work is done,
  publish it with `pnpm pr:ready` — a completed PR sitting in draft is an incomplete handoff.

### Per-layer stack CI (stop the line — no exceptions)

The automated agent ship gate covers **PR pushes**. Stack-layer rewrites push protected `fork/*`
tips directly — they are **not** PR pushes, so the husky gate does not fire and this fuller manual
gate is mandatory instead.

When rebasing, replaying, conflict-resolving, or otherwise rewriting **any** fork stack layer
(`fork/tim`, `fork/candidates`, `fork/changes`, an integration overlay, or composed
`fork/integration`):

1. Finish **only the current layer** (rebase/replay complete, lockfile consistent, conflicts
   resolved and recorded in `conflictResolutions` when applicable).
2. On that layer’s tip, run the **full local CI gate** — every step you can run on the host that
   Fork CI runs for a green PR tip:
   - `vp check`
   - `ELECTRON_SKIP_BINARY_DOWNLOAD=1 vp run -r --cache --log labeled typecheck`
   - `vp run --cache build:desktop` and preload verify (same as Fork CI **Check**)
   - `ELECTRON_SKIP_BINARY_DOWNLOAD=1 vp run test` (Fork CI **Test** — **required on every stack
     layer**, not optional)
   - On macOS hosts when mobile/desktop shell is in play: `vp run lint:mobile` and the Open With
     test from Fork CI **Mobile Native Static Analysis** when those paths are available
   - `node scripts/release-smoke.ts` when release/workflow packaging paths may have changed
3. **All of those steps must pass on the current layer.** Fix failures on **this** layer (commit +
   force-with-lease push the layer branch if it is shared). Do not paper over with a fix only on a
   child layer.
4. **Only after the current layer is fully green**, rebase/replay/compose the **next** layer onto
   it. Repeat from step 1.

**Layer order (never skip ahead):**

```text
main (upstream mirror — do not hand-edit product fixes)
  → fork/base (fork-only CI / repo plumbing)
  → fork/tim
  → fork/candidates
  → fork/changes
  → each integration overlay (in manifest order) onto fork/changes
  → fork/integration (compose last; full CI on the composed tip)
```

**Hard rules:**

- **One red layer blocks the entire rest of the rewrite.** Stop. Fix. Re-run the full gate on that
  layer. Then continue.
- **Never** stack “green later” commits, push a known-red parent, or compose `fork/integration`
  from layers that have not each passed the full gate.
- **Never** treat “the next layer will fix typecheck/lint/tests” as acceptable progress.
- Feature PRs and overlay children: after rebasing onto a parent, the **child tip** goes through the
  automated agent ship gate (ready-PR push or `pnpm pr:ready`) — plus this stack-layer full test gate
  if you are rewriting stack automation itself.

Full narrative and examples: [docs/fork-stack.md](./docs/fork-stack.md)
(“Per-layer full CI after stack rebase”).

### Client-visible verification

After frontend feature development or any user-visible frontend behavior change, the primary agent
must run one integrated verification pass for each affected client surface after integrating the
work:

- Web: use the `test-t3-app` skill. Launch one isolated environment, authenticate through the printed
  pairing URL, and verify the affected flow in the controlled browser.
- Mobile: use the `test-t3-mobile` skill. Connect one representative iOS Simulator or Android
  Emulator available on the host to one isolated environment and verify the affected flow. On
  compatible macOS hosts, prefer iOS for cross-platform changes and stream it through serve-sim in
  the T3 Code in-app browser or another available agent browser; use Android when it is the affected
  or viable platform.
- Subagents must not independently launch dev servers or repeat integrated client verification
  unless their delegated task explicitly requires it.
- Stop dev servers, watchers, and other long-running verification processes when the focused
  verification is complete.

## Dev Servers

- In a linked git worktree, dev state defaults to that worktree's gitignored `.t3`. This deliberately outranks an ambient `T3CODE_HOME`, which could otherwise select the installed app's live `~/.t3/userdata` database. An explicit `--home-dir` still wins.
- Start the web stack with `vp run dev`. Add `--share` when someone needs to open it from another device on the tailnet.
- Browser dev is single-origin: Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the backend. Do not set `VITE_HTTP_URL` or `VITE_WS_URL` for `dev`/`dev:web`.
- Worktree paths supply stable preferred port offsets. Read the actual server and web ports from the `[dev-runner]` line because occupied ports can still shift them.
- Before handing off a `--share` URL, open its origin in a controlled browser and confirm the app loads. A successful curl is insufficient because browsers reject some otherwise reachable ports.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, and manages provider sessions.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, and client-side state. Connects to the server via WebSocket.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
