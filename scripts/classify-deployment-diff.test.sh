#!/usr/bin/env bash

set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT

git -C "${work}" init --quiet
git -C "${work}" config user.email test@example.com
git -C "${work}" config user.name Test
mkdir -p "${work}/seed"
touch "${work}/seed/.keep"
git -C "${work}" add seed/.keep
git -C "${work}" commit --quiet -m seed
base="$(git -C "${work}" rev-parse HEAD)"

assert_scope() {
  local path="$1"
  local expected="$2"
  local output

  mkdir -p "${work}/$(dirname "${path}")"
  printf 'changed\n' >"${work}/${path}"
  git -C "${work}" add "${path}"
  git -C "${work}" commit --quiet -m "change ${path}"
  output="$(
    cd "${work}"
    bash "${root}/scripts/classify-deployment-diff.sh" "${base}" "$(git rev-parse HEAD)"
  )"
  while IFS='=' read -r key value; do
    [[ "$(sed -n "s/^${key}=//p" <<<"${output}")" == "${value}" ]] || {
      printf 'expected %s=%s for %s\n%s\n' "${key}" "${value}" "${path}" "${output}" >&2
      exit 1
    }
  done <<<"${expected}"
  git -C "${work}" reset --quiet --hard "${base}"
}

assert_scope apps/discord-bot/src/main.ts $'deploy=true\ndiscord=true\nserver=false\nvscode=false\nmobile=false\ndesktop=false'
assert_scope apps/vscode/src/extension.ts $'deploy=true\ndiscord=false\nserver=false\nvscode=true\nmobile=false\ndesktop=false'
assert_scope apps/mobile/src/App.tsx $'deploy=true\ndiscord=false\nserver=false\nvscode=false\nmobile=true\ndesktop=false'
assert_scope apps/desktop/src/main.ts $'deploy=true\ndiscord=false\nserver=false\nvscode=false\nmobile=false\ndesktop=true'
assert_scope apps/server/src/server.ts $'deploy=true\ndiscord=false\nserver=true\nvscode=false\nmobile=false\ndesktop=false'
assert_scope apps/web/src/App.tsx $'deploy=true\ndiscord=false\nserver=true\nvscode=false\nmobile=false\ndesktop=true'
assert_scope packages/client-runtime/src/index.ts $'deploy=true\ndiscord=true\nserver=true\nvscode=true\nmobile=true\ndesktop=true'
assert_scope pnpm-lock.yaml $'deploy=true\ndiscord=true\nserver=true\nvscode=true\nmobile=true\ndesktop=true'
assert_scope docs/deployment.md $'deploy=false\ndiscord=false\nserver=false\nvscode=false\nmobile=false\ndesktop=false'

echo "deployment classifier tests passed"
