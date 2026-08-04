#!/usr/bin/env bash
# Exercises the tracked native hooks configured by install-git-hooks.mjs: a raw
# `git worktree add` must fire post-checkout and commits must use the checked-in
# pre-commit hook from that worktree.

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
hook="${root}/.githooks/post-checkout"
[ -f "${hook}" ] || {
  echo "missing ${hook}" >&2
  exit 1
}

work="$(mktemp -d)"
git init -q "${work}/main"
cd "${work}/main"
git config user.email t@example.com
git config user.name t
mkdir -p .githooks
install -m 0755 "${hook}" .githooks/post-checkout
printf '#!/bin/sh\necho FIRED > "$(git rev-parse --show-toplevel)/.precommit"\n' >.githooks/pre-commit
chmod +x .githooks/pre-commit
git add -A
git commit -q -m init

# A file checkout (third argument 0) must not reconcile dependencies.
out="$(sh "${hook}" 2>&1 || true)"
[ -z "${out}" ] || {
  echo "FAIL: file checkout should be silent/no-op, got: ${out}" >&2
  exit 1
}

# Wire the tracked hook directory the way install-git-hooks.mjs does.
git config core.hooksPath .githooks

# --- a fresh `git worktree add` fires post-checkout (no pnpm-lock -> clean skip, exit 0) ---
git worktree add -q "${work}/wt" HEAD
# post-checkout must not abort the checkout even with nothing to install.
test -d "${work}/wt"

# A commit in the fresh worktree runs its tracked native pre-commit hook.
cd "${work}/wt"
git config user.email t@example.com
git config user.name t
echo change >f.txt
git add f.txt
git commit -q -m c
[ -f "${work}/wt/.precommit" ] && grep -q FIRED "${work}/wt/.precommit" || {
  echo "FAIL: native pre-commit did not run" >&2
  exit 1
}

# Dependency preparation is best-effort for native Git, but T3's explicit pass
# requests the real exit status so it can persist a degraded-worktree activity.
printf '{}\n' >package.json
printf 'lockfileVersion: 9\n' >pnpm-lock.yaml
sh .githooks/post-checkout HEAD HEAD 1 >/dev/null 2>&1 || {
  echo "FAIL: native checkout preparation failure must soft-fail" >&2
  exit 1
}
set +e
T3CODE_WORKTREE_PREPARATION_STRICT=1 sh .githooks/post-checkout HEAD HEAD 1 >/dev/null 2>&1
strict_status=$?
set -e
[ "${strict_status}" -ne 0 ] || {
  echo "FAIL: strict checkout preparation should preserve the package-manager failure" >&2
  exit 1
}

echo "worktree post-checkout hook tests passed"
