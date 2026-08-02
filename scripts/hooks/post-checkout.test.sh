#!/usr/bin/env bash
# Exercises the canonical worktree post-checkout hook and the shared-hooks-dir
# wiring that scripts/install-git-hooks.mjs sets up: a raw `git worktree add`
# must fire post-checkout (so node_modules gets installed) while commit/push
# hooks still delegate to the worktree's checked-in .husky/<name>.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hook="${root}/scripts/hooks/post-checkout"
[ -f "${hook}" ] || {
  echo "missing ${hook}" >&2
  exit 1
}

work="$(mktemp -d)"
git init -q "${work}/main"
cd "${work}/main"
git config user.email t@example.com
git config user.name t
mkdir -p .husky
printf '#!/bin/sh\necho FIRED > "$(git rev-parse --show-toplevel)/.precommit"\n' >.husky/pre-commit
chmod +x .husky/pre-commit
git add -A
git commit -q -m init

# --- the real post-checkout no-ops in the main worktree (git-dir == common-dir) ---
out="$(sh "${hook}" 2>&1 || true)"
[ -z "${out}" ] || {
  echo "FAIL: post-checkout should be silent/no-op in the main worktree, got: ${out}" >&2
  exit 1
}

# --- wire a shared absolute hooks dir the way install-git-hooks.mjs does ---
common="$(cd "$(git rev-parse --git-common-dir)" && pwd)"
shared="${common}/t3-hooks"
mkdir -p "${shared}"
install -m 0755 "${hook}" "${shared}/post-checkout"
cat >"${shared}/pre-commit" <<'DISPATCH'
#!/bin/sh
name=${0##*/}
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
h="$top/.husky/$name"
[ -f "$h" ] || exit 0
exec sh "$h" "$@"
DISPATCH
chmod +x "${shared}/pre-commit"
git config core.hooksPath "${shared}"

# --- a fresh `git worktree add` fires post-checkout (no pnpm-lock -> clean skip, exit 0) ---
git worktree add -q "${work}/wt" HEAD
# post-checkout must not abort the checkout even with nothing to install.
test -d "${work}/wt"

# --- commit in the fresh worktree still runs the husky pre-commit via dispatcher ---
cd "${work}/wt"
git config user.email t@example.com
git config user.name t
echo change >f.txt
git add f.txt
git commit -q -m c
[ -f "${work}/wt/.precommit" ] && grep -q FIRED "${work}/wt/.precommit" || {
  echo "FAIL: husky pre-commit did not run through the shared-dir dispatcher" >&2
  exit 1
}

echo "worktree post-checkout hook tests passed"
