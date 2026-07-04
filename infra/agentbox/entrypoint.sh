#!/usr/bin/env bash
set -euo pipefail

uid="${T3_AGENT_UID:-1000}"
gid="${T3_AGENT_GID:-1000}"

if ! getent group "$gid" >/dev/null; then
  groupadd --gid "$gid" agent
fi

if ! id -u patroza >/dev/null 2>&1; then
  useradd --uid "$uid" --gid "$gid" --home-dir /home/patroza --shell /usr/bin/bash patroza
fi

mkdir -p \
  /home/patroza \
  /home/patroza/.local \
  /home/patroza/.ssh \
  /home/patroza/.t3 \
  /home/patroza/pj \
  /cache/npm \
  /cache/pnpm \
  /cache/corepack \
  /cache/xdg \
  /var/cache/apt/archives/partial \
  /var/lib/apt/lists/partial \
  /run/sshd

if [[ -f /run/agent-ssh/authorized_keys ]]; then
  cp /run/agent-ssh/authorized_keys /home/patroza/.ssh/authorized_keys
  chmod 600 /home/patroza/.ssh/authorized_keys
fi

chown "$uid:$gid" \
  /home/patroza \
  /home/patroza/.local \
  /home/patroza/.ssh \
  /home/patroza/.t3 \
  /home/patroza/pj \
  /cache \
  /cache/npm \
  /cache/pnpm \
  /cache/corepack \
  /cache/xdg
chmod 700 /home/patroza/.ssh
if [[ "${T3_AGENT_SSHD:-1}" != "0" ]]; then
  ssh-keygen -A
  /usr/sbin/sshd
fi

export HOME=/home/patroza
export USER=patroza
export LOGNAME=patroza
export T3CODE_HOME="${T3CODE_HOME:-/home/patroza/.t3}"
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/cache/xdg}"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/cache/npm}"
export NPM_CONFIG_PREFIX="${NPM_CONFIG_PREFIX:-/home/patroza/.local}"
export PNPM_HOME="${PNPM_HOME:-/cache/pnpm}"
export COREPACK_HOME="${COREPACK_HOME:-/cache/corepack}"
export PATH="$PNPM_HOME:/home/patroza/.local/bin:/opt/t3code/node_modules/.bin:$PATH"

if [[ $# -gt 0 ]]; then
  exec gosu "$uid:$gid" "$@"
fi

exec gosu "$uid:$gid" node /opt/t3code/apps/server/dist/bin.mjs serve \
  --host 0.0.0.0 \
  --port 8080 \
  --base-dir "$T3CODE_HOME"
