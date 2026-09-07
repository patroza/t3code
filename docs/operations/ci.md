# CI quality gates

- `.github/workflows/fork-ci.yml` runs the fork quality gates for pull requests targeting
  `fork/dev` and for pushes to `fork/dev`. The inherited upstream `ci.yml` workflow is disabled so
  updates to the `main` mirror do not duplicate those checks.
- The inherited upstream `release.yml` (T3 Connect nightly on a three-hour cron, plus tag/desktop
  GitHub Releases) and `deploy-relay.yml` workflows are disabled at repository level. This fork does
  not deploy T3 Connect. Fork desktop and mobile shipping uses Fork Release, not `release.yml`.
- Upstream `release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`)
  desktop artifacts from a single `v*.*.*` tag. Leave it disabled here; do not re-enable it to
  “fix” the red scheduled Release job.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
