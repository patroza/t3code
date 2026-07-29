# Stack history rewrite (fold tip-only `fix(stack)` debt)

Goal: **layer tips green** and **replayed commits green**, without permanent product
`fix(stack): rejoin…` commits.

## What to fold vs keep

| Kind             | Examples                                                                     | Action                                                                                                                                                     |
| ---------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product recovery | #165, #166 (VCS / BranchToolbar / worktree cleanup / CommandPalette)         | Fold into the **Tim provenance or feature commit** that owns the surface; until then one well-named **product** commit (`fix(vcs):…`), never `fix(stack):` |
| Manifest-only    | “record conflict resolution” commits that only touch `.github/pr-stack.json` | Squash into one `chore(stack): conflict resolution registry` (or the first stack-tooling commit in the range)                                              |
| Stack machinery  | rebase-pr-stack, compose, CI helpers                                         | Keep; prefer `feat(fork-stack):` / `fix(fork-stack):`                                                                                                      |
| Docs for stack   | AGENTS / fork-stack policy                                                   | Keep with tooling                                                                                                                                          |

## Per-commit gate (required on rewrites)

```bash
CI= pnpm install --no-frozen-lockfile
node scripts/rebase-pr-stack.ts sync --dry-run --verify-each-commit
# when ready:
node scripts/rebase-pr-stack.ts sync --push --verify-each-commit
```

On failure, fix the **commit being replayed** (or its conflict resolution). Do not push a new tip
patch and call the rewrite done.

## Fold product #165 + #166 (already applied on `fork/changes` tip)

Those commits restored main #4727 ref-refresh behavior **and** fork `failureKind` / worktree cleanup
/ reuse-base-branch after whole-file Tim policies dropped one side. Fold them into a single product
commit:

```bash
git switch -C rewrite/fold-vcs-stack-fixes origin/fork/changes
# tip = #166, parent = #165, grandparent = durable resolutions only
git reset --soft HEAD~2
git commit -m "$(cat <<'EOF'
fix(vcs): keep #4727 ref refresh with fork failureKind and worktree cleanup

Join upstream Git ref-refresh resource-storm fixes with fork contracts
(failureKind, commit signing, worktree cleanup RPCs, reuse-base-branch UI)
instead of leaving tip-only fix(stack) recovery commits after Tim whole-file
conflict policies.

EOF
)"
# force-with-lease push fork/changes only after full layer gate
```

Long-term: on the next **Tim** layer rewrite, re-resolve `GitVcsDriverCore*`, `vcs.ts`,
`BranchToolbarBranchSelector` as a **3-way product merge** into the Tim provenance commit that
touches VCS, then **drop** any remaining recovery commit on `fork/changes`. Durable whole-file
`ours`/`theirs` for those paths has been **removed** from `conflictResolutions` so the next sync
stops auto-taking one side.

## Collapse manifest-only `fix(stack)` commits

List candidates (only `.github/pr-stack.json`):

```bash
git log --oneline origin/fork/candidates..origin/fork/changes --grep='fix(stack)' --name-only
```

Interactive rebase onto `origin/fork/candidates` and `fixup` pure-manifest commits into one
`chore(stack): conflict resolution registry` (or the first non-empty stack-tooling commit). Leave
commits that also touch product files alone until reviewed.

Automated sketch (review the todo before running):

```bash
# Produce a rebase todo that fixups consecutive manifest-only stack commits — review carefully.
git rebase -i origin/fork/candidates
```

Do **not** rewrite published SHAs without coordinating deploy/CI; use force-with-lease and recompose
`fork/integration`.

## Tim / candidates layer reds

`fork/tim` and `fork/candidates` may still fail full typecheck from older incomplete joins. Do not
paper over with changes-layer tips. Next full upstream stack rewrite:

1. Rewrite `fork/tim` with product merges + `--verify-each-commit` (or per-commit typecheck by hand).
2. Only then `fork/candidates` → `fork/changes` → overlays → integration.
3. Full per-layer CI after each tip (AGENTS.md stop-the-line).

## After any rewrite

1. Per-layer full CI on each tip.
2. `node scripts/compose-integration-overlays.ts` (or stack workflow compose).
3. Full Fork CI on `fork/integration`.
4. Confirm no new product `fix(stack):` tips landed.
