#!/usr/bin/env bash
# Continuous deploy for fingerprint runtime policy with full logging.
#
# For each platform:
#   1. Compute fingerprint
#   2. If a finished/in-progress build exists for that runtime → OTA only
#   3. Else try `eas build --no-wait` (+ optional --auto-submit)
#   4. Always publish an OTA for the current fingerprint after a successful
#      build queue so the binary picks it up when it finishes
#   5. If build fails (e.g. Expo Free plan monthly iOS quota), fall back to OTA
#      against the latest *finished* production binary's runtime so pure-JS
#      fixes still reach installed TestFlight clients
#
# Usage (from apps/mobile):
#   ./scripts/eas-continuous-deploy.sh \
#     --profile production \
#     --channel production \
#     --environment production \
#     --platform ios \
#     [--auto-submit] \
#     [--message "..."] \
#     [--runtime-version HASH]   # force OTA-only to this runtime (skip build)

set -euo pipefail

PROFILE=""
CHANNEL=""
ENVIRONMENT=""
PLATFORM="ios"
AUTO_SUBMIT=0
MESSAGE=""
FORCE_RUNTIME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --channel) CHANNEL="${2:-}"; shift 2 ;;
    --environment) ENVIRONMENT="${2:-}"; shift 2 ;;
    --platform) PLATFORM="${2:-}"; shift 2 ;;
    --auto-submit) AUTO_SUBMIT=1; shift ;;
    --message) MESSAGE="${2:-}"; shift 2 ;;
    --runtime-version) FORCE_RUNTIME="${2:-}"; shift 2 ;;
    -h | --help)
      sed -n '2,25p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PROFILE" || -z "$CHANNEL" ]]; then
  echo "--profile and --channel are required" >&2
  exit 1
fi

if [[ ! "$PLATFORM" =~ ^(ios|android|all)$ ]]; then
  echo "--platform must be ios, android, or all" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -z "$MESSAGE" ]]; then
  MESSAGE="EAS continuous deploy $(date -u +%Y-%m-%dT%H:%MZ) ${GITHUB_SHA:-local}"
fi

platforms=()
if [[ "$PLATFORM" == "all" ]]; then
  platforms=(ios android)
else
  platforms=("$PLATFORM")
fi

generate_fingerprint() {
  local platform="$1"
  local args=(fingerprint:generate --platform "$platform" --json --non-interactive)
  if [[ -n "$ENVIRONMENT" ]]; then
    args+=(--environment "$ENVIRONMENT")
  else
    args+=(--build-profile "$PROFILE")
  fi
  # JSON on stdout; progress on stderr
  eas "${args[@]}" | node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c));
    process.stdin.on("end", () => {
      const j = JSON.parse(s);
      const hash = j.hash || j.fingerprintHash;
      if (!hash) {
        console.error("fingerprint:generate returned no hash:", s.slice(0, 500));
        process.exit(1);
      }
      process.stdout.write(String(hash));
    });
  '
}

find_matching_build() {
  local platform="$1"
  local runtime="$2"
  eas build:list \
    --platform "$platform" \
    --build-profile "$PROFILE" \
    --runtime-version "$runtime" \
    --limit 5 \
    --json \
    --non-interactive \
    | node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c));
      process.stdin.on("end", () => {
        const builds = JSON.parse(s || "[]");
        const ok = new Set(["NEW", "IN_QUEUE", "IN_PROGRESS", "FINISHED"]);
        const b = builds.find((x) => ok.has(String(x.status || "").toUpperCase().replace(/-/g, "_")));
        if (b && b.id) process.stdout.write(String(b.id));
      });
    '
}

latest_finished_runtime() {
  local platform="$1"
  eas build:list \
    --platform "$platform" \
    --build-profile "$PROFILE" \
    --status finished \
    --limit 1 \
    --json \
    --non-interactive \
    | node -e '
      let s = "";
      process.stdin.on("data", (c) => (s += c));
      process.stdin.on("end", () => {
        const builds = JSON.parse(s || "[]");
        const b = builds[0];
        if (b && b.runtimeVersion) process.stdout.write(String(b.runtimeVersion));
      });
    '
}

publish_update() {
  local platform="$1"
  local runtime_override="${2:-}"
  local msg="$3"
  local env_args=()
  if [[ -n "$ENVIRONMENT" ]]; then
    env_args+=(--environment "$ENVIRONMENT")
  fi
  if [[ -n "$runtime_override" ]]; then
    echo "Publishing OTA for platform=$platform runtimeVersion=$runtime_override (override)"
    MOBILE_RUNTIME_VERSION_OVERRIDE="$runtime_override" eas update \
      --channel "$CHANNEL" \
      --platform "$platform" \
      --message "$msg" \
      --non-interactive \
      "${env_args[@]}"
  else
    echo "Publishing OTA for platform=$platform (fingerprint policy)"
    unset MOBILE_RUNTIME_VERSION_OVERRIDE || true
    eas update \
      --channel "$CHANNEL" \
      --platform "$platform" \
      --message "$msg" \
      --non-interactive \
      "${env_args[@]}"
  fi
}

try_build() {
  local platform="$1"
  local args=(
    build
    --platform "$platform"
    --profile "$PROFILE"
    --non-interactive
    --no-wait
  )
  if [[ "$AUTO_SUBMIT" -eq 1 ]]; then
    args+=(--auto-submit)
  fi
  echo "Starting eas build: ${args[*]}"
  # Capture output so Free-plan / credential errors are visible in CI logs
  if eas "${args[@]}"; then
    return 0
  fi
  return 1
}

for platform in "${platforms[@]}"; do
  echo "==== platform: $platform ===="

  if [[ -n "$FORCE_RUNTIME" ]]; then
    publish_update "$platform" "$FORCE_RUNTIME" "$MESSAGE (forced runtime $FORCE_RUNTIME)"
    continue
  fi

  echo "Generating fingerprint..."
  fingerprint="$(generate_fingerprint "$platform")"
  echo "$platform fingerprint: $fingerprint"

  echo "Looking for builds with runtimeVersion=$fingerprint ..."
  build_id="$(find_matching_build "$platform" "$fingerprint" || true)"
  if [[ -n "$build_id" ]]; then
    echo "Existing build found: $build_id — publishing OTA only"
    publish_update "$platform" "" "$MESSAGE"
    continue
  fi

  echo "No matching build for fingerprint $fingerprint — attempting native build"
  if try_build "$platform"; then
    echo "Native build queued; publishing OTA for current fingerprint so it is ready when the binary finishes"
    publish_update "$platform" "" "$MESSAGE"
    continue
  fi

  echo "Native build failed (often Expo Free plan monthly iOS quota or credentials)."
  echo "Falling back to OTA against the latest finished $PROFILE $platform binary runtime."
  fallback="$(latest_finished_runtime "$platform" || true)"
  if [[ -z "$fallback" ]]; then
    echo "ERROR: no finished $PROFILE $platform builds found to target for fallback OTA" >&2
    exit 1
  fi
  if [[ "$fallback" == "$fingerprint" ]]; then
    echo "Latest finished runtime equals current fingerprint but no matching build list hit; publishing with fingerprint policy"
    publish_update "$platform" "" "$MESSAGE (fallback)"
  else
    echo "Fallback runtimeVersion: $fallback (installed clients will receive pure-JS fixes)"
    echo "NOTE: native-input changes in this tip will not land until a new binary is built for $fingerprint"
    publish_update "$platform" "$fallback" "$MESSAGE (fallback runtime $fallback; tip fingerprint $fingerprint)"
  fi
done

echo "eas-continuous-deploy finished successfully"
