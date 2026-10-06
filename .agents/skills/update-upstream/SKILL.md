---
name: update-upstream
description: Weld the latest pingdotgg/t3code main into this fork's fork/dev. Use when the user says update from upstream, update from upstream main, update latest upstream, get latest upstream main, merge latest upstream, sync with upstream, or weld upstream, and when an open sync/upstream pull request should be finished or landed. /update-upstream
---

# Update from upstream

Branch policy, the ship gate, and why a weld lands with `gh pr merge --merge` are in `AGENTS.md` (Downstream fork branches, Pull requests, Agent ship gate). This file is the sequence. Do the work in its own worktree. Leave any other checkout alone.

Those phrases ask you to land the current `upstream/main` on `fork/dev`. Stop short of landing only when the user says to prepare the PR and not merge, or when the tip is stale or a required check is not green.

## Refresh the refs

From a checkout of this repo, with direnv loaded (`.envrc` points `GH_REPO` at the fork and puts `.tools/bin` first):

```bash
git fetch origin fork/dev
git fetch upstream main
```

Those are two commands. A single `git fetch` that names both remotes fails.

`origin` is this fork. `upstream` is `pingdotgg/t3code`. `git rev-parse --short` takes one revision. A second revision is consumed by `--short`, not printed.

If `upstream/main` is already an ancestor of `origin/fork/dev`, say so and stop.

## One open weld

List open PRs into `fork/dev` whose head branch matches `sync/upstream-*`. Keep a single one.

1. `origin/fork/dev` is not an ancestor of that head: merge `origin/fork/dev` into the weld branch. Do not rebase a branch that already contains the upstream merge commit.
2. `upstream/main` is not an ancestor of that head: merge `upstream/main` into the same branch. A ready PR pays the full ship gate on the push. Retitle the PR to the new upstream sha. Do not land the previous tip.
3. Both are ancestors, the PR is ready, `mergeable` is `MERGEABLE`, the base is `fork/dev`, and every required Fork CI check on that head is green: land it and stop.
4. Both are ancestors but a check is still running: watch that head. Do not open another PR.
5. A check failed: fix it on that branch.

No open weld: create one.

```bash
sha=$(git rev-parse --short=12 upstream/main)
git worktree add -b "sync/upstream-$sha" "<sibling>/sync-upstream-$sha" origin/fork/dev
git -C "<sibling>/sync-upstream-$sha" branch --unset-upstream
```

`<sibling>` is the directory `git worktree list` already uses for this repo. `git worktree add -b` from `origin/fork/dev` tracks that branch. Unset it before any push, or the push targets `fork/dev`. The post-checkout hook installs dependencies.

## Merge upstream

In the weld worktree, merge `upstream/main`. The merge message names the sha, says what the range is in a sentence or two, and ends with the model and harness line `AGENTS.md` requires.

Resolve conflicts as a 3-way merge. Keep both sides when each side still has a live behavior. When a symbol moved, follow the types now in the tree. Do not paste field names forward from an older weld. Never take a whole file with `--ours` or `--theirs`.

When `package.json`, `pnpm-workspace.yaml`, or `pnpm-lock.yaml` changed or conflicted, regenerate the lockfile the way `AGENTS.md` describes and commit that result.

Fork behavior that a test or `AGENTS.md` already requires stays. Upstream behavior the fork does not replace also stays. Typecheck is how you know the combination compiles. Read `.repos/effect-smol/LLMS.md` before writing Effect to fix the weld.

The server package is named `t3`. `vp run --filter server typecheck` matches nothing. The ship gate's `vpr typecheck` is the typecheck that counts. For a tighter loop, run `vp run typecheck` inside `apps/server`.

`apps/web/src/routeTree.gen.ts` is generated. If a gate or test dirties it, restore it with `git checkout --` and do not commit it.

A missing `node_modules/.bin` shim, for a package that is present under `node_modules/.pnpm`, is a fresh-worktree linker quirk when the command you needed still runs.

Commit compile fixes as their own commits on this branch. Attribution follows `AGENTS.md`. Do not invent `Co-authored-by` trailers.

## Pull request

Open a draft against `fork/dev` once the merge commit is reviewable. Title: `Merge upstream main through <sha>`. The body names the upstream range, says to land with `gh pr merge --merge`, and notes conflict resolutions that are not obvious from the diff.

Run `gh` in the worktree so the direnv shim applies. If `gh` hangs with no output, that process is the mise wrapper (`~/.local/bin/gh`). Call the binary from `mise which gh`. Do not hardcode a versioned path.

When the t3-code MCP server exposes `link_pull_request`, link this PR's full URL on the thread. Before you finish, list the thread's PRs and link a weld URL that is still missing. If the tool is absent, say so and retry when the server is back. Do not link unrelated PRs.

Publish with `pnpm pr:ready` when the weld is done. Follow the ship gate in `AGENTS.md`.

## Land

Wait until every required check on the PR head is green. Job names are the Fork CI jobs in `.github/workflows/fork-ci.yml`. A green local ship gate is not those checks. Fetch again before landing and confirm `upstream/main` and `origin/fork/dev` are still ancestors of the head. If either moved, return to "One open weld".

```bash
gh pr merge <n> --merge
```

Use that command, not the GitHub merge button. `AGENTS.md` records what a squash does to the next weld. After it lands, fetch `origin/fork/dev` and confirm `upstream/main` is an ancestor.

Do not push `origin/main`. This task does not move the mirror.

Merging the PR does not deploy. Fork CI on the `fork/dev` push approves that merge SHA. Say the environment is deployed only when that SHA is the one that was released.

## Leave the rest alone

Do not mix feature work into the weld. Do not re-enable the workflows `AGENTS.md` lists as `disabled_manually`.
