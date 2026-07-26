# Client integration overlays

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
- `extraction pending` is used only during the reviewed cutover. Do not add new implementation to
  `fork/changes`; finish or update the extraction first.

Shared contracts and runtime behavior stay in `fork/changes` unless they exist solely for one
integration. A feature spanning shared code and an extracted client is split into two PRs: the
shared prerequisite targets `fork/changes`, and the client child targets its overlay. The client PR
may temporarily depend on the shared PR and is rebased once that prerequisite lands.

The overlay PRs remain draft so they cannot be merged accidentally while still receiving normal CI.
Register their real PR numbers under `integrationOverlays` in `pr-stack.json` and replace the
temporary `null` ownership entries as part of the final cutover.

## Build and deployment ownership

Each overlay owns the code and repository-local build metadata required to produce its client:

- Discord owns `apps/discord-bot/**` and its operator-facing integration documentation.
- VS Code owns `apps/vscode/**` and the repository launch configuration in `.vscode/launch.json`.
- Workspace importer and lockfile changes travel with the overlay that introduces the app.

Cross-client classification remains shared in `scripts/classify-deployment-diff.sh`; it cannot live
in either client overlay because it decides between server, Discord, VS Code, mobile, and desktop.

Fleet installation, credentials, systemd units, host names, and artifact distribution remain in the
private `aaaomega/ops` repository. In particular, `scripts/deploy-fork-integration.sh`,
`scripts/build-and-deploy-vscode.sh`, `scripts/publish-fork-workstation-artifacts.sh`, and the guest
Discord service configuration consume the tested, composed `fork/integration` tree. They are
deployment infrastructure, not public client implementation, and therefore are not duplicated into
the product overlays.
