# fork/base

`fork/base` sits between the upstream mirror (`main`) and provenance layers:

```text
main → fork/base → fork/tim → fork/candidates → fork/changes → overlays → integration
```

## What belongs here

**Only** repository adaptations for this fork — not Tim imports, not candidates, not product UI.

| Area             | Examples                                                                                                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workflows        | `fork-ci.yml`, `compose-integration.yml`, `managed-pr-draft-lock.yml`, `rebase-pr-stack.yml`, Blacksmith-free `ci.yml`, fork EAS/release tweaks; drop upstream `pr-vouch` / `pr-size` when unused |
| Stack manifests  | `.github/pr-stack.json`, `client-overlay-ownership.json`, `upstream-candidates.json`                                                                                                              |
| Stack tools      | `scripts/fork-stack.ts`, `rebase-pr-stack.ts`, `compose-integration-overlays.ts`, `rebase-integration-overlays.ts`, `client-overlay-owner.ts`, `classify-deployment-diff.sh`                      |
| Agent / ops docs | `AGENTS.md`, `docs/fork-stack.md`, `docs/stack-ship-path.md`, `docs/stack-history-rewrite.md`, `docs/client-overlays.md`, this file                                                               |
| Root scripts     | `package.json` `fork:*` entries                                                                                                                                                                   |

## What does **not** belong here

- Tim Smart import commits (`feat(tim): …`)
- Upstream candidate provenance (`feat: import …`)
- Product features, mobile/web UI, contracts RPC behavior

Those stay on `fork/tim` / `fork/candidates` / `fork/changes` respectively.

## Restack

1. Update `main` from upstream.
2. Replay / rebuild **this** layer onto the new `main` tip (keep the fork infra tree).
3. Rebuild `fork/tim` → `fork/candidates` → `fork/changes` → overlays → compose.

Keep repository workflow **CI** (upstream Blacksmith) **disabled_manually**. Layer green is **Fork CI**.
