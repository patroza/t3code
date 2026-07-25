#!/usr/bin/env bash

set -euo pipefail

base_sha="${1:-}"
head_sha="${2:-}"

if [[ ! "${base_sha}" =~ ^[0-9a-f]{40}$ ]] || [[ ! "${head_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "usage: $0 <base-sha> <head-sha>" >&2
  exit 2
fi

is_non_runtime_path() {
  case "$1" in
    .agents/* | .github/* | docs/* | \
      AGENTS.md | CLAUDE.md | README.md | */README.md | \
      *.md | *.mdx | *.snap | \
      *.test.* | *.spec.* | \
      test/* | tests/* | */test/* | */tests/* | \
      */__snapshots__/* | */__tests__/* | */testUtils/* | */fixtures/* | \
      apps/server/scripts/acp-mock-agent.ts | scripts/release-smoke.ts)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

runtime_paths=()
non_runtime_paths=()
while IFS= read -r -d '' path; do
  if is_non_runtime_path "${path}"; then
    non_runtime_paths+=("${path}")
  else
    runtime_paths+=("${path}")
  fi
done < <(git diff --name-only -z "${base_sha}" "${head_sha}")

printf 'Changed paths: %d runtime, %d non-runtime\n' \
  "${#runtime_paths[@]}" "${#non_runtime_paths[@]}"

if ((${#runtime_paths[@]} > 0)); then
  printf 'Runtime-affecting paths:\n'
  printf '  %s\n' "${runtime_paths[@]}"
  printf 'deploy=true\n'
else
  printf 'Only tests, documentation, agent metadata, or CI metadata changed.\n'
  printf 'deploy=false\n'
fi
