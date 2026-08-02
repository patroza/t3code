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

// Point core.hooksPath at a shared ABSOLUTE dir under the git common dir. Husky's
// default is a *relative* `.husky/_`, which does not exist in a freshly
// `git worktree add`-ed worktree -- so git skips every hook there, and a raw
// `git worktree add` never installs node_modules (only the T3 app / t3.json
// path did). A shared absolute dir exists for every worktree, including brand
// new ones, so:
//   - post-checkout runs the worktree setup (pnpm install from the warm store),
//   - pre-commit/pre-push delegate to the current worktree's checked-in
//     .husky/<name>, so husky's lint-staged + ship gate keep working.
// This runs on every `pnpm install`, so smart and the t3vm guest converge on
// identical worktree behavior without a host-specific installer.
const configureSharedHooks = () => {
  const gitCommonDir = NodePath.resolve(
    root,
    NodeChildProcess.execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: root,
      encoding: "utf8",
    }).trim(),
  );
  const sharedHooks = NodePath.join(gitCommonDir, "t3-hooks");
  NodeFS.mkdirSync(sharedHooks, { recursive: true });

  // Canonical worktree-setup hook (shared by both hosts via this installer).
  NodeFS.copyFileSync(
    NodePath.join(root, "scripts", "hooks", "post-checkout"),
    NodePath.join(sharedHooks, "post-checkout"),
  );
  NodeFS.chmodSync(NodePath.join(sharedHooks, "post-checkout"), 0o755);

  // One dispatcher per checked-in husky hook. Delegates to the *current
  // worktree's* .husky/<name>; no-ops when that worktree has no such hook.
  const dispatcher = `#!/bin/sh
# Installed by scripts/install-git-hooks.mjs. core.hooksPath is a shared ABSOLUTE
# dir so post-checkout fires on a fresh 'git worktree add'; this dispatcher runs
# the current worktree's checked-in husky hook so the gate still applies.
name=\${0##*/}
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
hook="$top/.husky/$name"
[ -f "$hook" ] || exit 0
exec sh "$hook" "$@"
`;
  const huskyDir = NodePath.join(root, ".husky");
  const hookNames = NodeFS.existsSync(huskyDir)
    ? NodeFS.readdirSync(huskyDir).filter((name) => !name.startsWith("_") && !name.startsWith("."))
    : [];
  for (const name of hookNames) {
    const target = NodePath.join(sharedHooks, name);
    NodeFS.writeFileSync(target, dispatcher, { encoding: "utf8", mode: 0o755 });
    try {
      NodeFS.chmodSync(target, 0o755);
    } catch {
      // best-effort
    }
  }

  NodeChildProcess.execFileSync("git", ["config", "core.hooksPath", sharedHooks], { cwd: root });
};

try {
  configureSharedHooks();
} catch (error) {
  console.error(
    `install-git-hooks: could not configure shared hooks dir: ${error?.message ?? error}`,
  );
}

NodeProcess.exit(0);
