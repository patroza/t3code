# Copying Untracked Files into New Worktrees (`.worktreeinclude`)

When T3 Code creates a Git worktree for a thread, Git only checks out tracked files. Local files such as `.env`, `.envrc`, or an installed `node_modules` directory are not part of the checkout, so setup commands in a fresh worktree can fail until you copy them over by hand.

To fix that, add a `.worktreeinclude` file to your project root. It lists gitignore-style patterns for untracked files that should be copied from the source checkout into every newly created worktree, before any run-on-worktree-create setup script runs.

## Example

```gitignore
# .worktreeinclude
.env
.env.*
.envrc
node_modules/
```

With this file present, creating a new worktree copies every untracked `.env`, `.env.*`, and `.envrc` file (at any depth) and all `node_modules` directories into the new worktree.

## Pattern Syntax

Patterns use the same syntax and semantics as `.gitignore` — matching is done by Git itself:

- `pattern` without a slash matches at any depth (`.env` matches `apps/web/.env`).
- `pattern/` matches directories, copying their entire contents.
- `/pattern` anchors the match to the project root.
- `!pattern` re-excludes files matched by an earlier pattern.

Only untracked files are considered; tracked files are already part of the checkout. The `.worktreeinclude` file itself may be committed or kept untracked.

## Performance Notes

- Files are copied with copy-on-write cloning (reflinks) on filesystems that support it — btrfs and XFS on Linux, APFS on macOS — so including large trees such as `node_modules/.pnpm` is fast and takes almost no extra disk space. On other filesystems (for example ext4) a regular copy is made.
- Symlinks are preserved verbatim, so pnpm-style `node_modules` layouts keep working in the new worktree.
- Copy failures for individual files are logged as warnings and do not fail worktree creation.
