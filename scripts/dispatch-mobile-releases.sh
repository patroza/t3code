#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_REPOSITORY:?}" "${RELEASE_REF:?}" "${RELEASE_SHA:?}"
failed=0
for workflow in mobile-eas-production.yml mobile-eas-development.yml; do
  if ! state="$(gh api "repos/$GITHUB_REPOSITORY/actions/workflows/$workflow" --jq .state)"; then
    echo "ERROR: cannot read workflow state for $workflow" >&2
    failed=1
    continue
  fi
  case "$state" in
    active) ;;
    disabled_manually|disabled_inactivity|disabled_fork)
      echo "Skipping $workflow: repository workflow state is $state"
      continue ;;
    *) echo "ERROR: unexpected workflow state '$state' for $workflow" >&2; failed=1; continue ;;
  esac
  args=(workflow run "$workflow" --repo "$GITHUB_REPOSITORY" --ref "$RELEASE_REF"
    -f platform=ios -f "sha=$RELEASE_SHA" -f "release_branch=$RELEASE_REF")
  if [[ "$workflow" == mobile-eas-production.yml ]]; then
    args+=(-f mode=auto -f "message=$RELEASE_REF $RELEASE_SHA")
  fi
  if ! gh "${args[@]}"; then
    echo "ERROR: failed to dispatch $workflow" >&2
    failed=1
  fi
done
exit "$failed"
