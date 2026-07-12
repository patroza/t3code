#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REMOTE_HOST="${1:-patroza@100.105.158.115}"
UNPACKED_DIR="${ROOT_DIR}/release/linux-unpacked"

# No-sudo install: the unpacked app lives under the user's home and the launcher
# points straight at the binary. rsync replaces only changed files (writing a
# temp then renaming), so a running T3 Code keeps its open inodes and the next
# launch picks up the new version — update-while-running with no root.
INSTALL_SUBDIR=".local/opt/t3code"
BIN_SUBDIR=".local/bin"
DESKTOP_SUBDIR=".local/share/applications"

cd "${ROOT_DIR}"

# Compute a dir-deploy-specific version that includes the short commit and a
# monotonically increasing .n suffix. This ensures successive deploys produce
# distinct version strings (even without a formal release bump) so the running
# desktop can reliably detect "a newer build was just installed in this
# directory" and offer "Restart to update".
COMMIT=$(git rev-parse --short=12 HEAD 2>/dev/null || echo "unknown")
BASE_VERSION=$(node -p 'require("./apps/server/package.json").version' | sed 's/[-+].*//')

N_FILE=".dir-deploy-n"
if [[ -f "$N_FILE" ]]; then
  N=$(cat "$N_FILE")
else
  N=0
fi
N=$((N + 1))
echo "$N" > "$N_FILE"

DEPLOY_VERSION="${BASE_VERSION}.${N}+${COMMIT}"
echo "Dir deploy version: ${DEPLOY_VERSION}"

APP_VERSION="$DEPLOY_VERSION" pnpm run build
T3CODE_DESKTOP_VERSION="$DEPLOY_VERSION" pnpm run dist:desktop:linux:dir

if [[ ! -d "${UNPACKED_DIR}" ]]; then
  echo "No unpacked app found at ${UNPACKED_DIR}" >&2
  exit 1
fi

install_local() {
  mkdir -p "${HOME}/${INSTALL_SUBDIR}" "${HOME}/${BIN_SUBDIR}" "${HOME}/${DESKTOP_SUBDIR}"
  rsync -a --delete "${UNPACKED_DIR}/" "${HOME}/${INSTALL_SUBDIR}/"
  ln -sf "${HOME}/${INSTALL_SUBDIR}/t3code" "${HOME}/${BIN_SUBDIR}/t3code"
  cat > "${HOME}/${DESKTOP_SUBDIR}/t3code.desktop" <<EOF
[Desktop Entry]
Name=T3 Code
Exec="${HOME}/${INSTALL_SUBDIR}/t3code" %U
Terminal=false
Type=Application
Icon=t3code
StartupWMClass=t3code
Comment=T3 Code desktop
Categories=Development;
EOF
  echo "Installed locally at ${HOME}/${INSTALL_SUBDIR}"
}

install_remote() {
  local host="$1"
  local rhome
  rhome="$(ssh "${host}" 'echo "$HOME"')"
  ssh "${host}" "mkdir -p '${rhome}/${INSTALL_SUBDIR}' '${rhome}/${BIN_SUBDIR}' '${rhome}/${DESKTOP_SUBDIR}'"
  rsync -a --delete "${UNPACKED_DIR}/" "${host}:${rhome}/${INSTALL_SUBDIR}/"
  ssh "${host}" "ln -sf '${rhome}/${INSTALL_SUBDIR}/t3code' '${rhome}/${BIN_SUBDIR}/t3code'
cat > '${rhome}/${DESKTOP_SUBDIR}/t3code.desktop' <<EOF
[Desktop Entry]
Name=T3 Code
Exec=\"${rhome}/${INSTALL_SUBDIR}/t3code\" %U
Terminal=false
Type=Application
Icon=t3code
StartupWMClass=t3code
Comment=T3 Code desktop
Categories=Development;
EOF"
  echo "Installed on ${host} at ${rhome}/${INSTALL_SUBDIR}"
}

install_local
install_remote "${REMOTE_HOST}"

echo "Done. Deployed ${DEPLOY_VERSION}. Restart T3 Code to pick up the new version."
