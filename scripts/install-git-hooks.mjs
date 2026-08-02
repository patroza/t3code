#!/usr/bin/env node
// Installs the husky git hooks (runs from the root `prepare` script).
// Exits silently when husky is not installed — e.g. production installs
// without devDependencies.
//
// Git worktrees often miss `core.hooksPath` after husky; re-apply it so
// agent pre-push actually runs in T3/agent worktrees.
//
// Always installs `.tools/bin/gh` — agent policy shim that blocks `gh pr ready`
// (use `pnpm pr:ready`). Put `$REPO/.tools/bin` first on PATH in agent sessions.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const installAgentGhShim = () => {
  const toolsBin = NodePath.join(root, ".tools", "bin");
  const agentGh = NodePath.join(root, "scripts", "agent-gh.mjs");
  NodeFS.mkdirSync(toolsBin, { recursive: true });
  const shimPath = NodePath.join(toolsBin, "gh");
  const shim = `#!/usr/bin/env bash
# Installed by scripts/install-git-hooks.mjs — agent gh policy shim.
# Blocks coding-agent \`gh pr ready\`; use \`pnpm pr:ready\` instead.
set -euo pipefail
exec node ${JSON.stringify(agentGh)} "$@"
`;
  NodeFS.writeFileSync(shimPath, shim, { encoding: "utf8", mode: 0o755 });
  try {
    NodeFS.chmodSync(shimPath, 0o755);
  } catch {
    // best-effort on platforms without chmod
  }
};

try {
  installAgentGhShim();
} catch (error) {
  console.error(`install-git-hooks: could not install agent gh shim: ${error?.message ?? error}`);
}

let installHusky;
try {
  installHusky = (await import("husky")).default;
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND" || !error.message.includes("package 'husky'")) {
    throw error;
  }
  NodeProcess.exit(0);
}

const installError = installHusky();
if (installError) {
  console.error(installError);
  NodeProcess.exit(1);
}

for (const name of ["pre-commit", "pre-push"]) {
  const p = NodePath.join(root, ".husky", name);
  if (NodeFS.existsSync(p)) {
    try {
      NodeFS.chmodSync(p, 0o755);
    } catch {
      // best-effort
    }
  }
}

NodeProcess.exit(0);
