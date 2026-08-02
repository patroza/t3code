#!/usr/bin/env node
// Installs tracked native Git hooks (runs from the root `prepare` script).
//
// Always installs `.tools/bin/gh` — agent policy shim that blocks `gh pr ready`
// (use `pnpm pr:ready`). Put `$REPO/.tools/bin` first on PATH in agent sessions.
import * as NodeChildProcess from "node:child_process";
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

for (const name of ["post-checkout", "pre-commit", "pre-push"]) {
  const p = NodePath.join(root, ".githooks", name);
  if (NodeFS.existsSync(p)) {
    try {
      NodeFS.chmodSync(p, 0o755);
    } catch {
      // best-effort
    }
  }
}

try {
  NodeChildProcess.execFileSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: root });
} catch (error) {
  console.error(
    `install-git-hooks: could not configure native hooks dir: ${error?.message ?? error}`,
  );
}

NodeProcess.exit(0);
