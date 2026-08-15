# AGENTS.md

## Downstream fork branches and pull requests

```text
pingdotgg/t3code:main
    └── main           exact upstream mirror, fast-forward only
            └── fork/dev   product: PR target, squash-merge, release source
```

- **Change PRs:** branch from `fork/dev`, open every implementation PR against `fork/dev`, and
  squash-merge it. Never open implementation PRs against `main`.
- **Catching a published PR up:** once the PR is no longer draft, rebase onto latest `fork/dev` or
  merge latest `fork/dev` into the PR branch if it is behind or conflicting. Either is fine — pick
  one. Draft PRs skip this. After publish, watch required checks until they are green.
- **Updating from upstream:** fast-forward `main` to `upstream/main`, then classic-merge `main` into
  `fork/dev`. Never merge downstream work into `main`, and never use GitHub's **Sync fork** button.
  When the merge hits shared product paths, do a 3-way merge — never a blind whole-file
  `ours`/`theirs`.
- Independent features use parallel PRs based on `fork/dev`. Chain PRs only when one change
  genuinely depends on another, and merge that chain bottom-up.
- All features land in `fork/dev`, including upstreamable work. To send something upstream, open a
  PR from a branch cut against upstream `main` in the usual GitHub way.
- Opening or updating a PR runs Fork CI (`.github/workflows/fork-ci.yml`) but does not deploy.
  Releases come from green `fork/dev` SHAs. Machine topology and deployment implementation belong
  in a separate private operations repository, not this one.
- The inherited upstream **`.github/workflows/ci.yml` (Blacksmith runners)** and `deploy-relay.yml`
  workflows are **`disabled_manually` at repository level**. This fork has no Blacksmith runners.
  **Do not re-enable** them. After an accidental re-enable: `gh workflow disable CI --repo <fork>`.
- Persistence migrations: keep true upstream migrations in `Migrations.ts`; rewrite fork-local
  migrations into `ForkMigrations.ts`. Never share a migration ledger between upstream and fork
  histories.
- Fork product / UI changes must land with a test that fails if the surface disappears (pure
  helpers alone are not enough). Prefer `aria-label`/`data-testid` existence, or markers in
  `apps/web/src/forkSurfaceExistence.test.ts` for chrome.
- After a merge that touches dependencies, never leave `pnpm-lock.yaml` mismatched with
  `package.json`. Regenerate the lockfile (`CI= pnpm install --no-frozen-lockfile`) rather than
  taking `--ours`/`--theirs` on it.

## Pull requests (required handoff)

When implementation work for a user request is done (code, docs, config — not pure Q&A):

1. **Commit** the changes on a feature branch cut from `fork/dev`.
2. **Open or update a PR against `fork/dev`** before handing off. Never target `main`.
3. **Let the agent ship gate own validation** before saying “updated the PR” or finishing (see
   _Task Completion Requirements → Agent ship gate_):
   - **Draft / no-PR pushes** run `vp check` only on files changed against `fork/dev`. Commits
     already pay lint-staged (fmt + lint of staged files). Do **not** hand-run the workspace
     suite while drafting.
   - **Publishing** (`pnpm pr:ready`) requires HEAD to contain latest `fork/dev` (rebase or merge
     — your choice), then the **full** ship gate (`vp check` → `vpr typecheck` → `vp run test`).
     Only a failing gate stops it. Raw `gh pr ready` is not refused — the `.tools/bin/gh` shim
     runs the same gate first. The husky `pre-push` hook fails closed when PR state can’t be
     resolved.
   - **Published (ready) PRs** pay the full ship gate on every agent push. After publish, **watch
     the PR until required checks are green** (`gh pr checks` / `gh pr view`). Fix real failures
     and re-push; dismiss false positives with a written reason. Stay quiet when nothing is new.
     Stop when the bots are green on the latest commit.
   - Confirm with `gh pr view <n> --json baseRefName,mergeable,mergeStateStatus,url`
   - `baseRefName` must be `fork/dev`. After publish, `mergeable` should be `MERGEABLE` (CI may
     still be `UNSTABLE` while checks run — that is what you watch to green).
4. **Before pushing follow-ups**, verify PR state with `gh pr view` (or equivalent):
   - If the PR is **open** → update that branch and push; the
     gate re-runs for that HEAD (changed-file if draft, full if ready).
   - If the PR is **merged** or **closed** → do **not** keep committing on that branch.
     Start a new branch, re-apply unmerged work, and open a **new PR** against `fork/dev`.
5. Never assume an earlier PR in the session is still open.
6. **Never merge or request merge** (and never tell a bot to merge) a PR that has not passed the ship
   gate and whose required checks are not green — publish through `pnpm pr:ready` first, then
   watch CI. GitHub required checks on `fork/dev` are the backstop; the ship gate is what runs
   first.

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

### Agent ship gate (changed files on draft, full on ready / publish)

Publish validation is **automated**. Agents do **not** hand-run the workspace
linter/typechecker/tests as a routine pre-handoff ritual — the ship gate runs them at the right
moment, and caches a passing full-gate SHA.

**Mechanism** (`scripts/agent-pre-push.mjs`, `scripts/agent-pr-ready.mjs`, `scripts/lib/*.mjs`):

- Husky `pre-push` is the agent ship gate. It is a **no-op for humans** and only fires for coding
  agents (detected via `GROK_AGENT` / `T3_AGENT` / `AI_AGENT` / `CLAUDECODE` / Cursor / Codex env
  markers). Humans opt out per push with `SKIP_AGENT_PREPUSH=1` — **agents never set that flag** and
  never use `git push --no-verify`.
- When it runs:
  1. **Draft / no-PR:** `vp check` on files changed against `fork/dev` (fmt + lint). Same class of
     check as lint-staged on commit.
  2. **Ready / publish:** workspace **`vp check`** → **`vpr typecheck`** → **`vp run test`**.
     Cargo, mobile native, desktop packaging, and Release Smoke stay **CI-only** — do not hand-run
     them for ordinary PR handoff.
- The **full** gate **skips when the HEAD SHA is already cached** in `.run/agent-ship-gate.json`.
  Force with `AGENT_SHIP_GATE_FORCE=1`.

**When it runs:**

| Branch PR state        | Agent push                           |
| ---------------------- | ------------------------------------ |
| No open PR             | **changed-file** `vp check`          |
| **Draft** PR           | **changed-file** `vp check`          |
| **Ready** PR           | **full** ship gate on every push     |
| PR state can’t resolve | **full** ship gate (**fail closed**) |

The gate keys off the PR’s **ready state**, not its base.

**Publish path:** `pnpm pr:ready` — HEAD must contain latest `fork/dev`, then the **full** ship
gate, then the open draft is marked ready. After that, **watch GitHub checks until they are
green**. Raw `gh pr ready` (and the ready-for-review APIs) reach the same place: the `.tools/bin/gh`
policy shim runs the ship gate first and passes the command through when it is green, so publishing
is gated rather than forbidden and a red gate is the only thing that stops it. `AGENT_PR_SHIP=1`
marks a gate already passed — `pr:ready` sets it for its own undraft call so the gate runs once,
not twice. `.envrc` puts `$REPO/.tools/bin` first on `PATH` so the shim wins over system `gh`, and
sets `GH_REPO` to the fork so bare `gh pr` commands target it instead of gh's upstream-parent
default (explicit `--repo` still overrides); `scripts/install-git-hooks.mjs` installs both the
hooks and the shim on `prepare`.

**Agent workflow:**

- **Open the draft immediately** once a PR is in scope (user asked, or Discord/turn rules require it)
  and the first meaningful commit is useful to review. Keep committing and pushing while it is a
  draft — each push pays the **changed-file** check only.
- **Publish when the work is done — do not leave a finished PR in draft.** Catch up to latest
  `fork/dev` if needed, then `pnpm pr:ready`. That is the immediate next action, before handoff
  notes, so full CI can start. Draft is only for work-in-progress.
- **After publish, monitor the PR to green.** Poll checks and comments newer than the last push.
  Verify each bot finding against the source, fix real ones, dismiss false positives with a written
  reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.
- **Mid-loop feedback only:** while drafting, focused proof is fine — `vp test run <files>` for tests
  you touched, targeted lint/typecheck for the scope you changed. That is edit-loop signal, not a
  second gate.
- Fork product / UI changes still **must** ship an existence or behavior assertion that fails if the
  surface is dropped (not only pure helpers) — see `apps/web/src/forkSurfaceExistence.test.ts`.
  The gate’s `vp run test` then actually exercises it.
- Backend / contracts / runtime behavior changes **must** land with focused tests for the changed
  behavior; the gate’s `vp run test` runs them.

Pre-commit: husky runs `pnpm lint-staged` — `vp fmt` on all staged files plus `vp lint --fix` on
staged code files. Typecheck and unit tests stay in the full ship gate (ready / publish). If the
hook rewrites files, stage those rewrites, commit, and push again.

**Explicitly forbidden:**

- `git push --no-verify` / `git commit --no-verify`, or setting `SKIP_AGENT_PREPUSH` (human escape
  hatch only).
- Raw `gh pr ready` / the ready-for-review API to undraft — always `pnpm pr:ready`.
- Merging or requesting merge (including telling a bot to merge) a draft or any tip that has not
  passed the ship gate.
- Treating “CI will catch it” as a substitute for publishing through the gate. If a PR’s checks
  panel shows **no** Check job, it has not been through the gate — publish with `pnpm pr:ready`.
- Leaving Discord/agent work with commits but **no** PR (open a draft; draft pushes pay changed-file
  check).
- Publishing a PR that is behind `fork/dev`, or walking away from a published PR before its required
  checks are green.
- Leaving a **finished** PR in draft. Draft is for work-in-progress only; when the work is done,
  publish it with `pnpm pr:ready` — a completed PR sitting in draft is an incomplete handoff.

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
- Start the web stack with `vp run dev`. Sharing over the tailnet is three steps: run `vp run dev --share` in the background, wait for the `pairingUrl:` line in its output, paste that full URL (token included) in your reply. Do not wire up `tailscale serve` by hand for this, and do not open the URL yourself.
- The web app requires pairing. Hand over the pairing URL, not the bare origin. A URL without its token is useless to whoever you gave it to. If the token got consumed, mint a fresh one with `node apps/server/src/bin.ts pair` — note it carries standard scopes, while the startup URL carries admin scopes (needed for Settings → Connections management).
- Browser dev is single-origin: Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known` to the backend. Do not set `VITE_HTTP_URL` or `VITE_WS_URL` for `dev`/`dev:web`.
- Worktree paths supply stable preferred port offsets. Read the actual server and web ports from the `[dev-runner]` line because occupied ports can still shift them.
- Before handing off a `--share` URL, open its **origin only** (no path, no token) in a controlled browser and confirm the app loads — never the full pairing URL, whose one-time token the check would consume. A successful curl is insufficient because browsers reject some otherwise reachable ports.

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

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_, a pure _decider_ turns commands into persisted _events_, and a _projector_ derives the read model the UI renders. Provider CLIs run as subprocesses; per-provider _adapters_ translate their native protocols into orchestration events. Side effects run in queue-backed _reactors_ that emit _receipts_ when milestones land. Each turn ends with a _checkpoint_, a hidden git ref, so the app can diff and restore.

Full glossary with file links: `docs/internals/glossary.md`

## Where code lives

- `apps/server` - WebSocket, orchestration, providers, checkpointing. Effect-heavy: read `.repos/effect-smol/LLMS.md` before writing Effect code.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it, `apps/mobile` is React Native, `apps/marketing` is the site.
- `packages/contracts` - Effect/Schema contracts plus small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utils, subpath exports, no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Sync with `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, UI stays dumb.
- Inferred types over annotations. `any` is the enemy.
- Comments describe how a thing is used, and move when the code moves. To be used mostly to describe functions, not to annotate every line of behavior.
- Our users drive agents all day and notice a dropped frame, a lying spinner, and a stale label. No continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here fights the task in front of you, say so loudly and get a human sign-off before breaking it.

## Additional tips

- Don't verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security is important, but should not be over-indexed on, especially for dev mode/maintainer-only features.
