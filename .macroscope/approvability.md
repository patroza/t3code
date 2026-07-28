PRs that change any of the following paths or files must not be auto-approved and require human review:

- `.github/**`
- `.macroscope/**`
- `AGENTS.md`
- `docs/fork-stack.md`
- `apps/server/**`
- `apps/desktop/**`
- `apps/mobile/**`
- `packages/contracts/**`
- `packages/client-runtime/**`
- `packages/effect-acp/**`
- `packages/effect-codex-app-server/**`
- `packages/ssh/**`
- `packages/tailscale/**`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`

The following change classes also require human review even if they touch other paths:

- authentication, authorization, relay, SSH, or Tailscale behavior
- WebSocket, RPC, or provider-runtime protocol changes
- release, packaging, signing, updater, or deployment workflow changes
- cross-client shared-state changes that affect web, mobile, or desktop behavior
- changes that alter review policy, branch/PR automation, or stack-rewrite automation

Docs-only changes, README updates, localized tests, and narrow UI copy fixes may remain eligible for auto-approval when they do not overlap with the paths or change classes above.
