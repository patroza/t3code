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

server=false
discord=false
vscode=false
mobile=false
desktop=false

select_all() {
  server=true
  discord=true
  vscode=true
  mobile=true
  desktop=true
}

for path in "${runtime_paths[@]}"; do
  case "${path}" in
    apps/discord-bot/*)
      discord=true
      ;;
    apps/vscode/*)
      vscode=true
      ;;
    apps/mobile/*)
      mobile=true
      ;;
    apps/desktop/*)
      desktop=true
      ;;
    apps/server/*)
      server=true
      ;;
    apps/web/*)
      # The web application is served by both standalone servers and packaged
      # desktop clients.
      server=true
      desktop=true
      ;;
    packages/contracts/* | packages/shared/* | packages/client-runtime/*)
      # These packages cross every client/server boundary in the private fleet.
      select_all
      ;;
    *)
      # Root manifests, lockfiles, build tooling, and newly introduced runtime
      # paths are deliberately conservative until assigned a narrower owner.
      select_all
      ;;
  esac
done

deploy=false
if [[ "${server}" == "true" || "${discord}" == "true" || "${vscode}" == "true" ||
      "${mobile}" == "true" || "${desktop}" == "true" ]]; then
  deploy=true
fi

if [[ "${deploy}" == "true" ]]; then
  printf 'Runtime-affecting paths:\n'
  printf '  %s\n' "${runtime_paths[@]}"
else
  printf 'Only tests, documentation, agent metadata, or CI metadata changed.\n'
fi

printf 'deploy=%s\n' "${deploy}"
printf 'server=%s\n' "${server}"
printf 'discord=%s\n' "${discord}"
printf 'vscode=%s\n' "${vscode}"
printf 'mobile=%s\n' "${mobile}"
printf 'desktop=%s\n' "${desktop}"
