# CI quality gates

- `.github/workflows/fork-ci.yml` runs the fork quality gates for pull requests and for exact
  `fork/integration` SHAs dispatched by the stack workflow. The inherited upstream `ci.yml` workflow
  is disabled so updates to the exact `main` mirror do not duplicate those checks.
- `.github/workflows/release.yml` builds macOS (`arm64` and `x64`), Linux (`x64`), and Windows (`x64`) desktop artifacts from a single `v*.*.*` tag and publishes one GitHub release.
- The release workflow auto-enables signing only when platform credentials are present. macOS passkey builds additionally require `APPLE_TEAM_ID` and the `MACOS_PROVISIONING_PROFILE` secret; Windows uses Azure Trusted Signing. Without the core signing credentials, it still releases unsigned artifacts.
- See [Release Checklist](./release.md) for the full release/signing setup checklist.
