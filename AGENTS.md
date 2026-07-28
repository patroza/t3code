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
- **Per-layer full CI gate after stack rebase (required — stop the line):** when rebasing,
  replaying, or rewriting the stack, **every layer must pass the full local CI gate before you
  touch the next layer**. Do **not** rebase, compose, or push a child layer onto a parent that is
  still red. Do **not** “finish the stack rewrite first and green it later.”
  - Order: `fork/tim` → `fork/candidates` → `fork/changes` → each integration overlay → compose
    `fork/integration` last.
  - On **each** layer tip after it is rewritten: install/lock consistent, then run the **full**
    local Fork CI gate (not only `vp check`) — see **Per-layer stack CI (stop the line)** under
    Task Completion Requirements and [docs/fork-stack.md](./docs/fork-stack.md)
    (“Per-layer full CI after stack rebase”).
  - Fix **all** failures on that layer, commit, force-with-lease push if the layer is shared, then
    and only then advance.
  - Same stop-the-line rule for feature / overlay-child PRs after `pnpm fork:stack update`: rebase
    onto the fixed parent, run the full pre-push gate on the feature tip, then push/merge.
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
   - **Mandatory pre-push gate** (see Task Completion Requirements): run **`vp check`** and the
     **full monorepo typecheck** locally, fix every failure (including pre-existing breakage your
     tip inherits from the base), then push. Do not use Fork CI as the first formatter, linter, or
     typechecker. Scoped package typecheck alone is **not** enough.
   - `pnpm fork:stack update --push` (current branch) or `pnpm fork:stack update --push <pr>`
   - Confirm with `gh pr view <n> --json baseRefName,mergeable,mergeStateStatus,url`
   - `baseRefName` must be `fork/changes` for ordinary features or the intended parent branch for a
     dependent/overlay-child PR. `mergeable` should be `MERGEABLE` (CI may still be `UNSTABLE`
     while checks run).
4. **Before pushing follow-ups**, verify PR state with `gh pr view` (or equivalent):
   - If the PR is **open** → re-run the mandatory pre-push gate, update that branch (prefer
     `fork:stack update --push`), and push.
   - If the PR is **merged** or **closed** → do **not** keep committing on that branch.
     `pnpm fork:stack start <new-branch>`, re-apply unmerged work, and open a **new PR** against
     `fork/changes`.
5. Never assume an earlier PR in the session is still open.

## Discord-originated commits (REQUIRED)

When the Discord turn includes an **Identity map** block with ready-to-paste `Co-authored-by` trailers, attribution is **mandatory**, not optional:

1. Keep the environment default **author/committer** (usually the GitHub App bot).
2. **Every** `git commit` you create for that work MUST end with those exact trailers after a blank line. Do not invent emails for unmapped people.
3. Before `git push` / opening a PR, verify with `git log -1 --format=%B` that the trailers are present on each new commit.
4. A Discord-originated commit **without** the mapped trailers is incomplete — fix it (amend if not pushed, or a follow-up commit is not enough for GitHub multi-author on already-pushed SHAs; amend/rebase when safe).

GitHub multi-author avatars (`bot & human`) come from commit trailers, not from PR body prose alone.
**Do not** put `@github-login` mentions or a “Co-authors” bullet list in the PR description — that spams notification inboxes. Trailers are enough.

## Discord-originated pull requests (REQUIRED)

When Discord work produces commits (or is clearly intended to land):

0. **Always open a PR — do not wait for perfect green.** Create the PR as soon as there is something to review or track. If full lint / typecheck / focused tests / `vp check` are not finished yet, open it as a **draft**. Convert to ready for review only after those gates. A missing PR while work sits only on a remote branch is incomplete handoff.

When opening or updating a PR from a Discord thread:

1. **Discord footer (required in the PR description).** Append this exact footer form at the end of the PR body (use the **thread starter** when known, otherwise the current requester, and that thread’s real jump link):

```md
opened by [<displayName>](discord_user_id) in chat thread **Discord** · [Thread Title](https://discord.com/channels/<guild_id>/<channel_or_thread_id>/<message_id>)
```

Prefer the thread starter’s Discord id/display name from turn context. Do not skip this because the bot _might_ patch the body later — still write it when you create the PR so the first revision is correct. The bot may also hard-append the footer when a PR URL is linked; that is a safety net, not a reason to omit it.

2. If Discord turn context lists **Linked work items** / Jira issues for the thread, include those Jira issue links in the PR description (and prefer the primary key in the title/branch when one is clear).

3. Prefer opening the PR only after commits already include the Identity map `Co-authored-by` trailers (see above). Do not restate co-authors as `@mentions` in the PR body.

## Task Completion Requirements

### Mandatory pre-push / PR handoff gate (no exceptions)

**Before every `git push`, `fork:stack update --push`, non-draft PR open, ready-for-review
conversion, or “handoff / done” claim**, the agent **must** run the local gates that mirror Fork
CI’s **Check** job (format/lint/typecheck/desktop build pieces you can run on the host), fix all
failures, then push. Fork CI is a safety net, not the first typechecker.

**Always open a PR for Discord/agent work that produces commits** (see _Discord-originated pull
requests_). **Draft PR exception:** you may open/update a **draft** PR earlier for tracking once
commits exist, co-author trailers are correct, and focused tests for the changed behavior have been
run — even if full monorepo typecheck / root `vp check` are still in progress. Do not claim the work
is ready or mark the PR non-draft until the full gate below passes.

Run from the repository root, in order:

1. **`vp check`** — exact formatter/linter gate used by Fork CI **Check**. A focused format/lint
   while iterating is fine; it is **not** a substitute for this root command before ready handoff.
2. **Full monorepo typecheck** (matches Fork CI):

   ```bash
   ELECTRON_SKIP_BINARY_DOWNLOAD=1 vp run -r --cache --log labeled typecheck
   ```

   Equivalent: `vp run typecheck` / root `pnpm` typecheck script that runs recursive package
   typechecks. **Scoped** typecheck of only the package you edited is allowed **while iterating**,
   but **before ready handoff you must run the full recursive typecheck**. Failures in packages you
   did not touch still block: your tip inherits the base; fix or land a fix on the tip so CI is green.

3. **Desktop Check pieces when the tip can break them** (Fork CI **Check** also runs these): after
   desktop or preload-adjacent changes, run `vp run --cache build:desktop` and the preload verify
   steps from `.github/workflows/fork-ci.yml`. When in doubt on a stack layer rewrite, run them.
4. **Focused tests for behavior you changed** (not always the full workspace suite — see stack
   rule below):
   - `vp test run <test-files>` for built-in Vite+ tests, or the package’s `test` script when that
     is what the package uses.
   - Backend / contracts / runtime behavior changes **must** include and run focused tests for the
     changed behavior.
5. **Do not push a ready (non-draft) handoff** if steps 1–2 fail, or if required steps 3–4 fail.
   Fix first.

**Ordinary feature PRs (based on `fork/changes`):** full-workspace `vp run test` is optional unless
the user asks or the change clearly needs the whole suite. **Do not** skip steps 1–2 to save time
on ready handoff.

**Explicitly forbidden before ready handoff:**

- Ready/non-draft push after only unit tests, only scoped package typecheck, or only a partial lint.
- Marking a PR ready for review knowing typecheck or `vp check` was skipped or red.
- Treating “CI will catch it” as a substitute for local gates.
- Advancing a stack rewrite to the next layer while the current layer is red (see below).
- Leaving Discord/agent work with commits but **no** PR (use draft until gates finish).

While iterating mid-task (not yet ready), keep feedback loops small: format/lint the files you
touch, typecheck the packages you edit, run the smallest relevant tests. **The bar rises to the
full pre-push gate the moment you mark ready or claim done.**

### Per-layer stack CI (stop the line — no exceptions)

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
- Feature PRs and overlay children: after rebasing onto a parent, the **child tip** must also pass
  the ordinary pre-push gate (and stack-layer full test gate if you are rewriting stack automation
  itself) before push.

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
