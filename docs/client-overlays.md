# Client integration overlays

> [!IMPORTANT]
> **Superseded. Do not follow this for new work.**
>
> Contributors branch from and target **`fork/dev`** — every kind of work, including Discord, VS Code,
> identity and desktop. The integration overlays are drained and deregistered, and `fork/changes` and
> `fork/integration` are frozen. See
> [stable-dev-release-branch-handover.md](./stable-dev-release-branch-handover.md).
>
> Kept as a record of how the fork operated before 2026-08-06, and because the provenance stack
> (`main` → `fork/base` → `fork/tim` → `fork/candidates`) it describes is still current.

Discord and VS Code are long-lived product integrations rather than anonymous files in
`fork/changes`. Their complete client implementations live in parallel draft PRs based on
`fork/changes` and are composed into `fork/integration` like the desktop-link overlay.

Path ownership is recorded in
[`client-overlay-ownership.json`](../.github/client-overlay-ownership.json). Before choosing a base
branch, run:

```sh
pnpm fork:overlay-owner <changed-path> [changed-path...]
```

- `fork/changes` means no extracted client owns the path.
- A PR number means start a child with
  `pnpm fork:stack overlay-start <pr-number> <branch>` and merge that child into the overlay.
- Overlay **child** PRs (base = the overlay branch) require the **same** local pre-push gate and
  GitHub required checks (Check, Test, Mobile Native Static Analysis, Release Smoke) as PRs into
  `fork/changes`. Do not merge on Compose / draft-lock green alone. Fork CI runs for those bases;
  agents must still run `vp check` + full monorepo typecheck locally before ready handoff.
- `extraction pending` is used only during the reviewed cutover. Do not add new implementation to
  `fork/changes`; finish or update the extraction first.

Shared contracts and runtime behavior stay in `fork/changes` unless they exist solely for one
integration. A feature spanning shared code and an extracted client is split into two PRs: the
shared prerequisite targets `fork/changes`, and the client child targets its overlay. The client PR
may temporarily depend on the shared PR and is rebased once that prerequisite lands.

The overlay PRs remain **draft** so they cannot be merged accidentally while still receiving normal
CI. Each permanent overlay draft **must** have the **`OVERLAY`** label. Register their real PR
numbers under `integrationOverlays` in `pr-stack.json` and replace temporary `null` ownership
entries as part of the final cutover.

### Closed overlay PR recovery

If a permanent overlay PR is closed by mistake:

1. Fix the overlay **branch** (rebase onto current `fork/changes`, force-with-lease).
2. **`gh pr reopen <n>`** — keep the same number; restore draft + **`OVERLAY`**.
3. Only if reopen is impossible: create a new draft PR for that branch, label **`OVERLAY`**, and
   update `pr-stack.json` `integrationOverlays[].number` in the same change.

Do not mint a replacement overlay PR as the default path. See
[fork-stack.md](./fork-stack.md) (“Permanent draft PRs — reopen first”).

### Fixing overlay tips

When the bug is on the overlay tip itself (reapply strip, typecheck, format), **amend or rewrite**
the commit that introduced it and force-with-lease the overlay branch. Prefer that over stacking
tip-only recovery commits. Feature work still uses child PRs that merge into the overlay.

## Build and deployment ownership

Each overlay owns the code and repository-local build metadata required to produce its client:

- Discord owns `apps/discord-bot/**` and its operator-facing integration documentation.
- VS Code owns `apps/vscode/**` and the repository launch configuration in `.vscode/launch.json`.
- The shared lockfile retains the extracted clients' existing importer metadata so the parallel
  overlays can compose without both rewriting the same file. Future dependency changes still
  belong to the owning overlay and must pass the integration composition check.

Cross-client classification remains shared in `scripts/classify-deployment-diff.sh`; it cannot live
in either client overlay because it decides between server, Discord, VS Code, mobile, and desktop.

Fleet installation, credentials, systemd units, host names, and artifact distribution remain in the
private `aaaomega/ops` repository. In particular, `scripts/deploy-fork-integration.sh`,
`scripts/build-and-deploy-vscode.sh`, `scripts/publish-fork-workstation-artifacts.sh`, and the guest
Discord service configuration consume the tested, composed `fork/integration` tree. They are
deployment infrastructure, not public client implementation, and therefore are not duplicated into
the product overlays.
