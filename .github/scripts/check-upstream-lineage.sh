#!/usr/bin/env bash
#
# check-upstream-lineage.sh — fail when a commit that carried an upstream sync
# reached the deploy branch without its second parent.
#
# Squash- and rebase-merging a sync PR keeps the code and throws the lineage
# away: the upstream commits stop being ancestors, so `fork/dev..upstream/main`
# reports work as missing that is already merged, and the next sync re-merges
# and re-resolves all of it. #401 landed that way and nobody noticed until a
# deploy alert two merges later said "Commits (2)".
#
# Ordinary fork PRs are expected to squash. Only commits that carried an
# upstream sync are checked, identified by the head branch of the PR they came
# from rather than by their subject line, because subjects vary:
#
#   Merge pull request #400 from patroza/sync/upstream-2026-08-12b
#   Merge upstream/main into fork/dev (23 commits) (#401)
#   merge: sync upstream through b73232bdd
#
# Usage:
#   check-upstream-lineage.sh                 # $BEFORE..$AFTER from the push event
#   check-upstream-lineage.sh <range|sha>...  # explicit, for local checks
#
# Env:
#   GH_TOKEN              authenticates the PR lookup for squash/rebase commits;
#                         without it those fall back to the subject line
#   SYNC_BRANCH_PATTERN   regex of sync head branches (default: ^sync/upstream)
set -euo pipefail

SYNC_BRANCH_PATTERN="${SYNC_BRANCH_PATTERN:-^sync/upstream}"
REPOSITORY="${GITHUB_REPOSITORY:-patroza/t3code}"

if [[ $# -gt 0 ]]; then
  revisions=("$@")
else
  before="${BEFORE:-}"
  after="${AFTER:-}"
  if [[ -z "${after}" ]]; then
    echo "no commit range: set BEFORE/AFTER or pass a range" >&2
    exit 2
  fi
  # A new branch (or a force push past the old tip) reports an all-zero or
  # unreachable "before"; check just the tip rather than the repository.
  if [[ -z "${before}" || "${before}" =~ ^0+$ ]] || ! git cat-file -e "${before}^{commit}" 2>/dev/null; then
    revisions=("${after}" "--not" "${after}^@")
  else
    revisions=("${before}..${after}")
  fi
fi

# The PR a commit arrived through. Squash and rebase merges leave "(#123)" in
# the subject; merge commits say "Merge pull request #123". Falling back to the
# API keeps this working when a subject was rewritten by hand.
pull_request_number() {
  local subject="$1"
  if [[ "${subject}" =~ Merge\ pull\ request\ \#([0-9]+) ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return
  fi
  if [[ "${subject}" =~ \(\#([0-9]+)\)[[:space:]]*$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return
  fi
  printf ''
}

# A merge-button commit already names the branch: "Merge pull request #400 from
# patroza/sync/upstream-2026-08-12b". Squash and rebase commits do not, so those
# fall back to the API. Never gated on a token being present in the environment:
# `gh` may be authenticated by other means, and a lookup that cannot run just
# leaves the commit to the subject-line fallback.
pull_request_head_branch() {
  local number="$1" subject="$2"
  if [[ "${subject}" =~ Merge\ pull\ request\ \#[0-9]+\ from\ [^/]+/(.+)$ ]]; then
    printf '%s' "${BASH_REMATCH[1]}"
    return
  fi
  [[ -n "${number}" ]] || return 0
  gh api "repos/${REPOSITORY}/pulls/${number}" --jq '.head.ref' 2>/dev/null || true
}

violations=0
checked=0

while read -r sha; do
  parents="$(git log -1 --format='%p' "${sha}")"
  subject="$(git log -1 --format='%s' "${sha}")"
  parent_count=0
  [[ -n "${parents}" ]] && parent_count="$(wc -w <<<"${parents}")"

  number="$(pull_request_number "${subject}")"
  head_branch=""
  head_branch="$(pull_request_head_branch "${number}" "${subject}")"

  is_sync=0
  if [[ -n "${head_branch}" && "${head_branch}" =~ ${SYNC_BRANCH_PATTERN} ]]; then
    is_sync=1
  elif [[ "${subject}" =~ ^([Mm]erge\ upstream|merge:\ sync\ upstream) ]]; then
    # Direct pushes and hand-written sync merges never reach the PR lookup.
    is_sync=1
  fi

  [[ "${is_sync}" -eq 1 ]] || continue
  checked=$((checked + 1))

  if [[ "${parent_count}" -lt 2 ]]; then
    violations=$((violations + 1))
    echo "::error::${sha} carried an upstream sync but has ${parent_count} parent(s): ${subject}"
    [[ -n "${head_branch}" ]] && echo "  head branch: ${head_branch} (PR #${number})"
  else
    echo "ok  ${sha} ${subject} — ${parent_count} parents"
  fi
done < <(git rev-list "${revisions[@]}")

if [[ "${violations}" -gt 0 ]]; then
  cat >&2 <<'GUIDANCE'

An upstream sync landed without its second parent — squash- or rebase-merged.
The code is there; the lineage is not.

Repair it without changing the tree, naming the exact upstream tip that sync
merged (not upstream/main, which would falsely claim newer commits too):

  git checkout fork/dev && git pull --ff-only
  git merge -s ours <upstream-sha> -m "chore(sync): record the upstream lineage"
  git diff --stat HEAD^ HEAD    # must be empty
  git push origin fork/dev

Merge sync PRs with `gh pr merge <n> --merge`. The GitHub button remembers
"Squash and merge", which is right for every other PR here and wrong for these.
GUIDANCE
  exit 1
fi

echo "checked ${checked} sync commit(s), all keep their upstream parent"
