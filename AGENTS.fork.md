# AGENTS.fork.md

Fork-only rules for `patroza/t3code`, a downstream fork of `pingdotgg/t3code`. `AGENTS.md` is
upstream's file and stays upstream's apart from the one line that points here. Where the two
disagree, this file wins.

## Branches

```text
pingdotgg/t3code:main
    └── main        exact upstream mirror, fast-forward only
            └── fork/dev   product: PR target, squash-merge, release source
```

- Branch every change from `fork/dev` and open its PR against `fork/dev`. Never target `main`.
- Do not push `main` except to fast-forward it to `upstream/main`. Never merge fork work into it,
  and never use GitHub's **Sync fork** button.
- Independent features get parallel PRs. Chain PRs only when one change needs another, and merge the
  chain bottom-up.
- Upstreamable work lands in `fork/dev` too. To send it upstream, open a separate PR from a branch
  cut from upstream `main`.
- The `fork/dev` ruleset requires a PR and the Fork CI checks (`Check`, `Test`, `Mobile Native
  Static Analysis`, `Release Smoke`) on every merge. It does not require linear history, so upstream
  merge commits land, and no user can bypass it, so nothing lands red, upstream merges included.
  Treat a red `Fork Seams` check as blocking too.

## The seam rule

Upstream merges stay cheap only while fork changes stay out of upstream's files.

- Fork logic lives in files that do not exist upstream (`fooFork.ts`, `forkIntegrations.ts`,
  `app.config.fork.ts`, ...). Prefer upstream extension points that already exist: registries, layer
  lists, toolkit registration, optional schema fields.
- An upstream file may only get a hook: an import plus a single call, spread, registration, or
  layer entry. When an edit cannot shrink to a hook (an optional contract field inside an upstream
  struct), keep it minimal and say why.
- Every upstream file the fork modifies or deletes is listed in `fork-seams.txt` as
  `<path>  # <feature>: <why>`, sorted. Every other upstream file stays byte-identical to the
  upstream merge base. `node scripts/check-fork-seams.mjs` enforces this; Fork CI runs it as
  `Fork Seams`. It also warns about entries that no longer differ: drop them.
- Upstream workflows stay byte-identical too. Fork CI/CD lives in `fork-*.yml` and other fork-only
  workflows, fork mobile identity in `apps/mobile/eas.fork.json`.
- Do not edit upstream test files. Fork tests live in fork-only test files and assert only what the
  fork owns. Never pin upstream shapes: no full migration lists, full settings catalogs, source-text
  `toContain` of upstream components, or full `vi.mock` export lists.
- Do not change upstream behavior, constants, or caching. Behavior upstream lacks goes behind the
  fork module.
- Persistence: true upstream migrations stay in `Migrations.ts`; fork migrations go in
  `ForkMigrations.ts` (table `t3_fork_sql_migrations`) with stable ids. Never share a ledger.
- Fork user docs are fork-only pages in `docs/user/` (`github-pr-conversations.md`,
  `jira-issue-conversations.md`, `mcp-client-tokens.md`). Do not add fork text or links to
  upstream pages or to `docs/README.md`; link from the fork page to upstream's instead.
- Fork product and UI changes land with a test that fails if the surface disappears, such as an
  `aria-label` or `data-testid` existence check.

## Upstream merges

Merge upstream small and often; a short range is a short conflict list. The sequence is
`.agents/skills/update-upstream/SKILL.md`; `node scripts/merge-upstream.mjs` runs its mechanical
steps up to a draft PR and stops for superseded-feature drops, real conflicts, and failed checks.
The rules:

- An upstream merge is a real merge commit. Land its PR with `gh pr merge <n> --merge`, never the
  GitHub button: ordinary fork PRs squash, so the button remembers squash and drops the second
  parent. `upstream-lineage-guard.yml` flags that on the next `fork/dev` push.
- Before merging, check the incoming range against `fork-seams.txt` and the fork-only modules. A
  fork change that upstream now covers (same behavior, same fix, or a superseding feature) is
  dropped first: its fork-only files, its hooks, and its `fork-seams.txt` line. The fork keeps a
  change only while upstream has nothing equivalent. Name every drop in the merge PR body.
- Resolve conflicts as a 3-way merge, never a whole-file `--ours`/`--theirs`. In a seam file, take
  upstream's version and re-apply the fork's hook.
- After the merge, the seams check is green, the build compiles, and the tests pass before it lands.
  Never land red.
- After a merge that touches dependencies, regenerate the lockfile
  (`CI= pnpm install --no-frozen-lockfile`) instead of taking either side of `pnpm-lock.yaml`.

## Workflows

- Fork CI (`fork-ci.yml`) runs the required checks on GitHub-hosted runners. Upstream's `ci.yml`
  runs on Blacksmith runners the fork does not have. When upstream adds a CI gate, mirror it in
  Fork CI.
- Fork Release (`fork-release.yml`) runs after a green Fork CI push to `fork/dev`. It classifies the
  range with `scripts/classify-deployment-diff.sh` and dispatches `fork-mobile-eas-production.yml`.
  Server, Discord, desktop, and VS Code are promoted by the private operations repository's
  poller, which keeps machine topology and deployment. They do not belong in this repo.
- Upstream workflows that only run on upstream's Blacksmith runners, are guarded to
  `pingdotgg/t3code`, or triage upstream's issues are `disabled_manually` at repository level, with
  their files left byte-identical to upstream: `ci`, `deploy-relay`, `release`,
  `mobile-eas-production`, `mobile-dev-client`, `mobile-android-apk`, `mobile-eas-preview`,
  `mobile-eas-preview-fork`, `mobile-showcase-screenshots`, `web-preview`, `relay-preview`,
  `relay-preview-cleanup`, `desktop-macos-preview`, `desktop-macos-preview-publish`,
  `windows-tests`, `issue-vouch`, `issue-labels`, `stale-needs-more-info`, `publish-aur`.
  **Do not re-enable them.** After an accidental re-enable, run
  `gh workflow disable .github/workflows/<file>.yml --repo patroza/t3code`. When an upstream merge
  adds a workflow, decide the same way: disable it unless it runs on GitHub-hosted runners and
  does something for the fork.

## Pull requests (required handoff)

This overrides upstream's "never make a PR unless asked". When implementation work for a request is
done (code, docs, config; not pure Q&A):

1. Commit on a feature branch cut from `fork/dev`.
2. Open or update a PR against `fork/dev`. Open it as a draft as soon as the first meaningful
   commit is reviewable.
3. Publish with `pnpm pr:ready` when the work is done. Do not leave a finished PR in draft.
4. Watch the published PR until required checks are green: call `watch_pull_request` and end your
   turn. Fix real failures, dismiss false positives with a written reason.
5. Before pushing follow-ups, check the PR with `gh pr view <n> --json
   state,baseRefName,mergeable,mergeStateStatus,url`. Open: push to it. Merged or closed: start a
   new branch and a new PR. Never assume an earlier PR is still open.
6. Never merge, or ask anyone (including a bot) to merge, a PR whose tip has not passed the ship
   gate and whose required checks are not green.

## Agent ship gate

`.vite-hooks/pre-push` runs `scripts/agent-pre-push.mjs`. It only acts for coding agents (detected
via `GROK_AGENT`, `T3_AGENT`, `AI_AGENT`, `CLAUDECODE`, Cursor, or Codex env markers) and is a no-op
for humans.

| Branch PR state        | Agent push                                                           |
| ---------------------- | -------------------------------------------------------------------- |
| No open PR / draft PR  | `vp check` on files changed against `fork/dev`, then `vpr typecheck` |
| Ready PR               | full gate: `vp check`, `vpr typecheck`, `vp run test`                |
| PR state can't resolve | full gate (fails closed)                                             |

- A passing full gate is cached per HEAD SHA in `.run/agent-ship-gate.json`. Force a rerun with
  `AGENT_SHIP_GATE_FORCE=1`.
- `pnpm pr:ready` requires HEAD to contain the latest `fork/dev`, runs the full gate, then marks the
  draft ready. Raw `gh pr ready` reaches the same place: the `.tools/bin/gh` shim (installed by
  `scripts/fork-prepare.mjs`, put first on `PATH` by `.envrc`) runs the gate first. `.envrc` also
  sets `GH_REPO` to the fork so bare `gh pr` commands do not target upstream.
- Do not hand-run the workspace suite as a pre-handoff ritual; the gate runs it on publish. While
  iterating, focused `vp test run <files>` and targeted typechecks are fine.
- Cargo, mobile native, desktop packaging, and Release Smoke stay CI-only.
- Forbidden: `git push --no-verify`, `git commit --no-verify`, setting `SKIP_AGENT_PREPUSH` (a human
  escape hatch), publishing a PR that is behind `fork/dev`, and treating "CI will catch it" as a
  substitute for the gate.

## Discord-originated work

When a Discord turn includes an **Identity map** with ready-to-paste `Co-authored-by` trailers:

- Keep the environment's default author and committer. Every commit for that work ends with those
  exact trailers after a blank line. Do not invent emails for unmapped people. Check with
  `git log -1 --format=%B` before pushing; amend unpushed commits that miss them.
- Always open a PR, as a draft once the first meaningful commit exists. A branch without a PR is an
  incomplete handoff.
- End the PR body with this footer, using the thread starter when known and the thread's real link:

  ```md
  opened by [<displayName>](discord_user_id) in chat thread **Discord** · [Thread Title](https://discord.com/channels/<guild_id>/<channel_or_thread_id>/<message_id>)
  ```

- When the turn lists linked Jira issues, link them in the PR body and prefer the primary key in
  the title and branch.

## Client-visible verification

After a user-visible frontend change, the primary agent runs one integrated pass per affected
client after integrating the work: `test-t3-app` for web (one isolated environment, paired through
the printed URL), `test-t3-mobile` for mobile (one simulator or emulator; a missing native client
is a `vp run mobile:install` step, not a blocker). Subagents do not launch dev servers. Stop what
you started when the pass is done.
