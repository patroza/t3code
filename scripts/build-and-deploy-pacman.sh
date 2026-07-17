#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${1:-patroza@patricks-b18}"

find_latest_pacman() {
  find "${ROOT_DIR}/release" -maxdepth 1 -type f -name 'T3-Code-*-x64.pacman' -printf '%T@ %p\n' \
    | sort -nr \
    | head -n1 \
    | cut -d' ' -f2-
}

cd "${ROOT_DIR}"

pnpm run build
pnpm run dist:desktop:linux:pacman

PACMAN_PATH="$(find_latest_pacman)"

if [[ -z "${PACMAN_PATH}" ]]; then
  echo "No .pacman package found under ${ROOT_DIR}/release" >&2
  exit 1
fi

PACMAN_FILE="$(basename "${PACMAN_PATH}")"
REMOTE_TMP="/tmp/${PACMAN_FILE}"

# pacman -U replaces the on-disk files in /opt. A currently-running T3 Code
# keeps its already-open (mmapped) inodes, so the live window is unaffected;
# the next launch picks up the new version — same swap-while-running behavior
# the old AppImage `mv -f` had.
echo "Installing locally (sudo password required)..."
sudo pacman -U --noconfirm "${PACMAN_PATH}"

echo "Copying package to ${REMOTE_HOST}..."
scp "${PACMAN_PATH}" "${REMOTE_HOST}:${REMOTE_TMP}"

echo "Installing on ${REMOTE_HOST} (sudo password required)..."
ssh -t "${REMOTE_HOST}" "sudo pacman -U --noconfirm '${REMOTE_TMP}' && rm -f '${REMOTE_TMP}'"

echo "Built artifact: ${PACMAN_PATH}"
echo "Installed locally and on ${REMOTE_HOST} (package: t3code)."
echo "Restart T3 Code to pick up the new version."
