#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${1:-patroza@patricks-b18}"
LOCAL_HOME="${HOME}"
LOCAL_TMP_APPIMAGE="${LOCAL_HOME}/T3-Code-new.AppImage"
LOCAL_APPIMAGE="${LOCAL_HOME}/T3-Code.AppImage"
REMOTE_HOME="/home/patroza"
REMOTE_TMP_APPIMAGE="${REMOTE_HOME}/T3-Code-new.AppImage"
REMOTE_APPIMAGE="${REMOTE_HOME}/T3-Code.AppImage"

find_latest_appimage() {
  find "${ROOT_DIR}/release" -maxdepth 1 -type f -name 'T3-Code-*-x86_64.AppImage' -printf '%T@ %p\n' \
    | sort -nr \
    | head -n1 \
    | cut -d' ' -f2-
}

cd "${ROOT_DIR}"

pnpm run build
pnpm run dist:desktop:linux

APPIMAGE_PATH="$(find_latest_appimage)"

if [[ -z "${APPIMAGE_PATH}" ]]; then
  echo "No AppImage found under ${ROOT_DIR}/release" >&2
  exit 1
fi

cp "${APPIMAGE_PATH}" "${LOCAL_TMP_APPIMAGE}"
mv -f "${LOCAL_TMP_APPIMAGE}" "${LOCAL_APPIMAGE}"

scp "${APPIMAGE_PATH}" "${REMOTE_HOST}:${REMOTE_TMP_APPIMAGE}"
ssh "${REMOTE_HOST}" "mv -f '${REMOTE_TMP_APPIMAGE}' '${REMOTE_APPIMAGE}'"

echo "Built artifact: ${APPIMAGE_PATH}"
echo "Installed locally: ${LOCAL_APPIMAGE}"
echo "Installed on ${REMOTE_HOST}: ${REMOTE_APPIMAGE}"
