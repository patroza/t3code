---
name: update-upstream
description: Weld the latest pingdotgg/t3code main into this fork's fork/dev. Use when the user says update from upstream, update from upstream main, update latest upstream, get latest upstream main, merge latest upstream, sync with upstream, or weld upstream, and when an open sync/upstream pull request should be finished or landed. /update-upstream
---

# Update from upstream

The rules are in `AGENTS.fork.md` (Branches, The seam rule, Upstream merges, Agent ship gate). This file is the sequence. Work in a worktree of its own and leave other checkouts alone.

Those phrases ask you to land one batch: the `upstream/main` already merged into the open weld. Stop short of landing only when the user says to prepare the PR and not merge, or when a required check on that head is not green. A newer `upstream/main` does not make the tip stale. Land the green head, then ask before the next batch. Never merge newer upstream into the same PR.

Merge small and often. A weld of a few days of upstream is a short conflict list; a month is a rewrite.

## Run the script first

From a checkout of this repo, with direnv loaded (`.envrc` points `GH_REPO` at the fork and puts `.tools/bin` first):

```bash
node scripts/merge-upstream.mjs --dry-run   # fetch, print the range and its fork-seams.txt overlap
node scripts/merge-upstream.mjs             # weld it, up to a draft PR
```

`scripts/merge-upstream.mjs` runs the mechanical part of this file: fetches `origin fork/dev` and `upstream main` separately, stops when `upstream/main` is already in `origin/fork/dev` (exit 0, "up to date") or a `sync/upstream-*` PR is open (exit 4, prints its number: finish that one, see One open weld). Otherwise it creates the sibling worktree `sync-upstream-<sha12>` on `sync/upstream-<sha12>` with tracking unset, runs `vp i`, prints the overlap report, merges with the message below, and resolves `pnpm-lock.yaml` (upstream's, then `CI= pnpm install --no-frozen-lockfile`) and locale catalogs under `apps/*/src/i18n/translations/` (key-level 3-way merge; keys both sides changed are left as conflicts). Then it runs the seams check, `vp run i18n:check`, and `vp run typecheck`, pushes through the normal pre-push gate, opens the draft PR, and adds `agent-context-increase` with an explaining comment when every value that grew in `agentContextBudget.json` equals upstream's. The last stdout line is a JSON summary. `--help` lists flags, exit codes, and the attribution env overrides.

It never publishes or lands. What stays with you:

- **Superseded fork changes.** Read the overlap report. When something must be dropped, run with `--prepare` (stops before merging), commit the drops in the weld worktree (see Drop what upstream now ships), then `node scripts/merge-upstream.mjs --continue` there. Name the drops in the PR body.
- **Real conflicts (exit 2).** The script lists the files left. Resolve them as Merge upstream says, `git add` them, then `--continue` in the weld worktree.
- **Failed checks (exit 3).** Fix in commits of their own (After the merge), then `--continue`. A failed push is exit 3 too; `--continue` retries it.
- **Fork/dev moved, publishing, and landing.** One open weld and Land below.

The sections below are the sequence the script follows and the reference for doing any step by hand.

## Refresh the refs

```bash
git fetch origin fork/dev
git fetch upstream main
```

Those are two commands; one `git fetch` naming both remotes fails. `origin` is this fork, `upstream` is `pingdotgg/t3code`. `git rev-parse --short` takes one revision.

If `upstream/main` is already an ancestor of `origin/fork/dev`, say so and stop.

## One open weld

List open PRs into `fork/dev` whose head branch matches `sync/upstream-*`. Keep a single one.

1. `origin/fork/dev` is not an ancestor of its head: merge `origin/fork/dev` into the weld branch. Do not rebase a branch that already contains the upstream merge commit.
2. `upstream/main` moved past the head: leave it. Do not merge it in, retitle, or push for it.
3. The PR is ready, `mergeable` is `MERGEABLE`, the base is `fork/dev`, `origin/fork/dev` is an ancestor of the head, and every required check on that head is green: land it (see Land), then ask about the next batch. Do not open that batch in the same turn.
4. A check is still running: watch that head. Do not merge newer upstream while you wait or open another PR.
5. A check failed: fix it on that branch without widening it to a newer `upstream/main`.

No open weld: create one.

```bash
sha=$(git rev-parse --short=12 upstream/main)
git worktree add -b "sync/upstream-$sha" "<sibling>/sync-upstream-$sha" origin/fork/dev
git -C "<sibling>/sync-upstream-$sha" branch --unset-upstream
```

`<sibling>` is the directory `git worktree list` already uses for this repo. Unset the upstream before any push, or the push targets `fork/dev`. Run `vp i` in the new worktree if the t3.json setup did not.

## Drop what upstream now ships (before merging)

Do this on the weld branch before `git merge`, so the dropped hunks never conflict.

1. List the incoming range and what it touches:

   ```bash
   base=$(git merge-base HEAD upstream/main)
   git log --oneline "$base..upstream/main"
   git diff --stat "$base" upstream/main
   ```

2. Intersect it with the fork's footprint: every `fork-seams.txt` entry the range touches, and every fork-only module whose area the range changes (same directory, same service, same feature).
3. For each fork change in that intersection, decide:
   - **Superseded**: upstream now ships the same behavior, the same fix, or a feature that replaces it. Drop the fork's copy in its own commit, `chore(fork): drop <thing>, upstream ships it in <sha>`: its fork-only files, its hooks in upstream files, and its `fork-seams.txt` line.
   - **Still needed**: keep it. Its hook gets re-applied after the merge.

   The fork keeps a change only while upstream has nothing equivalent. When unsure, read upstream's change and the fork module side by side; do not keep both.

4. Record every drop for the PR body.

## Merge upstream

Merge `upstream/main` into the weld branch. The merge message names the sha, summarizes the range in a sentence or two, and ends with the model and harness line.

- Resolve conflicts as a 3-way merge. Never take a whole file with `--ours` or `--theirs`.
- In a seam file (listed in `fork-seams.txt`), take upstream's version and re-apply the fork's hook from the entry's description. Do not carry fork logic back into the upstream file.
- In a fork-only file, follow the types now in the tree. Do not paste field names forward from an older weld. Read `.repos/effect-smol/LLMS.md` before writing Effect.
- When `package.json`, `pnpm-workspace.yaml`, or `pnpm-lock.yaml` changed or conflicted, regenerate the lockfile with `CI= pnpm install --no-frozen-lockfile` and commit the result.
- `apps/web/src/routeTree.gen.ts` is generated. Restore it with `git checkout --` if a gate dirties it, unless a route change needs it.

## After the merge

1. Run the seams check and fix every finding:

   ```bash
   node scripts/check-fork-seams.mjs
   ```

   An unlisted upstream file means a fork change leaked into upstream's file: move it back behind a hook, or restore the file. A stale entry means the hook is gone: drop the line.

2. Sanity pass for overlaps only visible once the code is combined: fork modules that now duplicate an upstream service, registry entries upstream already adds, fork tests that now fail because upstream changed the behavior on purpose. Treat each as a step-3 decision above (drop or keep), not a test to patch around.
3. Fix compile and test failures in commits of their own. The server package is named `t3`; `vp run typecheck` inside `apps/server` is the tight loop, `vpr typecheck` the one that counts.
4. Never land red. A weld with a failing check stays open until it is green.

Attribution follows `AGENTS.fork.md`. Do not invent `Co-authored-by` trailers.

## Pull request

Open a draft against `fork/dev` once the merge commit is reviewable. Title: `Merge upstream main through <sha>`. The body names the upstream range, lists the fork changes dropped because upstream ships them (with the upstream sha), notes non-obvious conflict resolutions, and says to land with `gh pr merge --merge`.

Run `gh` in the worktree so the direnv shim applies. If `gh` hangs with no output, that process is the mise wrapper (`~/.local/bin/gh`); call the binary from `mise which gh`.

When the t3-code MCP server exposes `link_pull_request`, link this PR's full URL on the thread.

Keep the weld a draft until the batch is ready to land, then publish once with `pnpm pr:ready`. Do not publish and then absorb a newer `upstream/main`.

## Land

Wait until every required check on the PR head is green, `Fork Seams` included. A green local gate is not those checks. Fetch `origin/fork/dev`; it must be an ancestor of the head. If not, merge it into the weld branch, push, and wait for the new head to go green.

```bash
gh pr merge <n> --merge
```

Never the GitHub merge button: it remembers squash, which drops the second parent. After landing, fetch `origin/fork/dev` and `upstream/main`. If `upstream/main` is not an ancestor, say how many commits remain and ask whether to weld the next batch.

Do not push `origin/main` as part of this task.

## Verify deployment

A merged weld is not a deployment. Follow Fork CI for the merged `fork/dev` SHA, then Fork Release and the private operations repository's runbook. Verify the running revision and service health before calling the update complete; report the actual running revision. A failed deployment is unfinished work: repair or retry within the user's authorization, or hand back the concrete blocker and the last verified revision. Mobile and desktop releases need their own verification when in scope.

## Leave the rest alone

Do not mix feature work into the weld. Do not re-enable workflows `AGENTS.fork.md` lists as `disabled_manually`.
