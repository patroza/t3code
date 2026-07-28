# AGENTS.md

## Downstream fork branches and pull requests

Read [docs/fork-stack.md](./docs/fork-stack.md) before creating, rebasing, merging, or retargeting
branches.

- Before the documented one-time cutover, implementation PRs continue to target `main`.
- After cutover, `main` is an upstream mirror. Never merge downstream fork work into it.
- Update `main` only through the `Rebase fork PR stack` workflow. Do not use GitHub's **Sync fork**
  button, open a PR into `main`, or push it manually. The scheduled/manual workflow uses the
  repository-scoped `FORK_STACK_DEPLOY_KEY` to bypass `main` protection, preserve the exact upstream
  commit SHA, and atomically rebuild `fork/tim`, `fork/changes`, and `fork/integration`.
- `fork/tim` contains only selected Tim Smart integrations above upstream. `fork/candidates`
  contains selected open upstream PRs that we run before upstream accepts them, one provenance
  commit per source PR. The permanent `fork/changes` PR is based on `fork/candidates`, contains only
  our downstream layer, remains open, and is the GitHub/T3 default branch.
- Long-lived upstreamable features may be registered as `integrationOverlays`. They remain parallel
  draft PRs based on `fork/changes`; `fork/integration` composes them in manifest order. Never merge
  a registered overlay directly. Update its branch, or use
  `pnpm fork:stack overlay-start <pr> <branch>` and target the child PR at the overlay branch.
  Draft state blocks merging while normal green CI remains meaningful.
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
- The stack workflow runs every six hours and may be dispatched manually to mirror
  `pingdotgg/t3code:main`. Its deploy key is the only automation bypass for protected `main`; agents
  must never print, replace, or reuse that credential outside this workflow.
- Fork checks live in `.github/workflows/fork-ci.yml` and run for PRs or by explicit integration
  dispatch. The inherited upstream `.github/workflows/ci.yml` and `deploy-relay.yml` workflows are
  disabled at repository level so mirror updates do not run redundant CI or attempt upstream relay
  deployment. Do not re-enable or target those workflows for fork releases.
- Updating `fork/tim` or merging a PR into `fork/changes` triggers the stack workflow, which rebases
  the provenance layers, rebuilds `fork/integration`, and parent-first force-with-lease rebases the
  complete same-repository PR tree rooted at `fork/changes` (including overlay children and deeper
  dependent PRs), then dispatches CI for the exact integration SHA.
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
- **Per-layer green before next layer (required):** when rebasing, rewriting, or composing the
  stack, **every layer must be fully green before you advance**. That means local pre-push gates
  **and** Fork CI (all jobs that apply to that ref) on that layer's tip — not “push and hope.” Order:
  `fork/tim` → `fork/candidates` → `fork/changes` → each overlay → compose `fork/integration`.
  Do not stack work on a red tip. Full detail: [docs/fork-stack.md](./docs/fork-stack.md)
  ("Per-layer green gate").
- **Conflict resolutions (required when stack hits conflicts):** do **not** only hand-resolve and
  resume. Update `.github/pr-stack.json` `conflictResolutions` so the next sync auto-applies the
  same side. Prefer durable `commit: "*"` + path policies; exact SHAs go stale after every rewrite.
  During rebase, `theirs` = commit being replayed, `ours` = new base. Documented in
  [docs/fork-stack.md](./docs/fork-stack.md) ("Conflict resolutions").
- **Integration compose lockfiles:** overlay lock commits diverge by design. Compose skips
  lockfile-only commits, defers lock-only conflicts, and regenerates one integration
  `pnpm-lock.yaml` at the end. Never push a partial `fork/integration` after a lock conflict.
  Compose seeds `node_modules` via `cp -a --reflink=auto` from a warm tree into a **home-side**
  work dir (`~/.t3/compose-work`, not tmpfs `/tmp`) before install. See
  [docs/fork-stack.md](./docs/fork-stack.md) ("Integration overlay compose and lockfiles").

## Pull requests (required handoff)

When implementation work for a user request is done (code, docs, config — not pure Q&A):

1. **Commit** the changes on a feature branch created with `pnpm fork:stack start <branch>` (from
   `fork/changes`).
2. **Open or update a PR against `fork/changes`** before handing off. Do not target `main` unless
   the change is intentionally an upstream-mirror / promote projection.
3. **Keep the PR mergeable** before saying “updated the PR” or finishing:
   - Complete the **mandatory pre-push verification** (see Task Completion Requirements) — never
     push knowing only “the tests I thought of” passed while check/typecheck were skipped.
   - `pnpm fork:stack update --push` (current branch) or `pnpm fork:stack update --push <pr>`
   - Confirm with `gh pr view <n> --json baseRefName,mergeable,mergeStateStatus,url`
   - `baseRefName` must be `fork/changes` for ordinary features or the intended parent branch for a
     dependent/overlay-child PR. `mergeable` should be `MERGEABLE` (CI may still be `UNSTABLE`
     while checks run).
4. **Before pushing follow-ups**, verify PR state with `gh pr view` (or equivalent):
   - If the PR is **open** → update that branch (prefer `fork:stack update --push`) and push.
   - If the PR is **merged** or **closed** → do **not** keep committing on that branch.
     `pnpm fork:stack start <new-branch>`, re-apply unmerged work, and open a **new PR** against
     `fork/changes`.
5. Never assume an earlier PR in the session is still open.

## Discord-originated pull requests

When opening a PR from a Discord thread request, append this footer at the end of the PR description (use the current requester and that thread’s real jump link):

```md
opened by [<displayName>](discord_user_id) in chat thread **Discord** · [Thread Title](https://discord.com/channels/<guild_id>/<channel_or_thread_id>/<message_id>)
```

If Discord turn context lists **Linked work items** / Jira issues for the thread, include those Jira issue links in the PR description (and prefer the primary key in the title/branch when one is clear).

## Task Completion Requirements

### Mandatory pre-push verification (every push)

**Before every `git push` / force-with-lease / PR open / PR update / stack layer push, complete the
full local gate below and fix failures.** Do not push red work “for CI to catch.” Fork CI is a
second line of defense, not the first typecheck or formatter.

Run from the repository root on the commit you are about to push (after install/lockfile are
consistent with that tree):

1. **Root Check gate (always):** `vp check`  
   Exact formatter/linter gate used by Fork CI **Check**. Focused format/lint while iterating is
   fine; it is **not** a substitute for root `vp check` right before push.
2. **Package typecheck (always for touched scope):** run the package typecheck for **every**
   package whose types can break from the change (import-extension, `exactOptionalPropertyTypes`,
   cross-package consumers). Prefer package filters / binaries, e.g.:
   - `pnpm --filter @t3tools/client-runtime exec tsgo --noEmit`
   - `apps/web` → `tsgo --noEmit` (or workspace filter)
   - `apps/mobile` → `tsc --noEmit`
   - `apps/server` / package name `t3` → that package’s typecheck
   - If `pnpm exec` is blocked by prepare hooks, use `node_modules/.bin/tsgo` / `tsc` from the
     package directory.
3. **Focused tests (always when behavior/tests exist):** `vp test run <test-files>` for changed
   behavior. Backend changes must include and run focused tests for the changed behavior. Use
   `vp run test` only when that package’s `test` script is the right tool.
4. **Lockfile (when manifests or deps changed):** regenerate until frozen install would succeed
   (`CI= pnpm install --no-frozen-lockfile` as needed) and commit a matching `pnpm-lock.yaml`.

**Explicitly do not skip** check, typecheck, or focused tests to save time. **Do not** treat
“unit tests passed” as enough if typecheck was not run.

**Heavy / optional (do not run as routine pre-push unless the user asks or the change requires it):**

- Full-repo `vp run typecheck`, `vp run test`, or monorepo-wide test matrix
- Integrated browser/mobile verification (see below — required only for user-visible client changes)
- Long E2E, full mobile native suites, release packaging

### After push: stack layers must be fully CI-green before the next layer

When working the fork stack (rebase, rewrite, overlay update, compose, recovery):

```text
main (mirror only)
  → fork/tim
  → fork/candidates
  → fork/changes
  → each overlay (desktop, discord, vscode)
  → fork/integration (compose last)
```

**Rules (required):**

1. Finish **local pre-push verification** on the layer tip, then push that layer.
2. **Wait for Fork CI on that layer’s tip to pass every applicable job** (Check, Test, and any
   other jobs that run for that ref — not only a subset). Fix failures and re-push until green.
3. **Only then** rebase/update the next layer onto the green parent (or compose integration).
4. **Never** advance with “CI still running / red, fix later.” Cascading red layers is a process
   failure.
5. Feature PRs: same local gate before every push; do not open/update a PR knowing typecheck or
   `vp check` was skipped.

Confirm CI with `gh run list` / `gh pr checks` / `gh run view` for the exact SHA you pushed.

### Client verification (user-visible UI only)

After frontend feature development or any user-visible frontend behavior change, the primary agent
must run one integrated verification pass for each affected client surface after integrating the
work:

- Web: use the `test-t3-app` skill. Launch one isolated environment, authenticate through the
  printed pairing URL, and verify the affected flow in the controlled browser.
- Mobile: use the `test-t3-mobile` skill. Connect one representative iOS Simulator or Android
  Emulator available on the host to one isolated environment and verify the affected flow. On
  compatible macOS hosts, prefer iOS for cross-platform changes and stream it through serve-sim in
  the T3 Code in-app browser or another available agent browser; use Android when it is the
  affected or viable platform.
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
