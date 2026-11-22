#!/usr/bin/env node
// Fork-only `prepare` step before upstream's `vp config`; Node built-ins only (runs before deps).
// Removes tsgo patch backups, unsets the legacy core.hooksPath=.githooks so `vp config` installs
// .vite-hooks (fork pre-push/post-checkout live there), self-ignores .tools/ and .run/ so the
// upstream .gitignore stays untouched, and installs the .tools/bin/gh agent policy shim.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const warn = (what, error) =>
  console.error(
    `fork-prepare: could not ${what}: ${error instanceof Error ? error.message : error}`,
  );

const backups = NodeFS.globSync(
  "node_modules/.pnpm/@typescript+{native-preview-*,typescript-*}/node_modules/@typescript/{native-preview-*,typescript-*}/lib/{tsgo,tsc}{,.exe}.original*",
  { cwd: root },
);
for (const backup of backups) NodeFS.rmSync(NodePath.join(root, backup), { force: true });
if (backups.length > 0) console.log(`fork-prepare: removed ${backups.length} stale tsgo backup(s)`);

try {
  const hooksPath = NodeChildProcess.spawnSync("git", ["config", "--local", "core.hooksPath"], {
    cwd: root,
    encoding: "utf8",
  });
  if (hooksPath.status === 0 && hooksPath.stdout.trim() === ".githooks") {
    NodeChildProcess.execFileSync("git", ["config", "--local", "--unset", "core.hooksPath"], {
      cwd: root,
    });
    console.log("fork-prepare: unset legacy core.hooksPath=.githooks");
  }
} catch (error) {
  warn("migrate core.hooksPath", error);
}

for (const dir of [".tools", ".run"]) {
  try {
    NodeFS.mkdirSync(NodePath.join(root, dir), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, dir, ".gitignore"), "*\n");
  } catch (error) {
    warn(`ignore ${dir}/`, error);
  }
}

try {
  const toolsBin = NodePath.join(root, ".tools", "bin");
  NodeFS.mkdirSync(toolsBin, { recursive: true });
  const agentGh = NodePath.join(root, "scripts", "agent-gh.mjs");
  NodeFS.writeFileSync(
    NodePath.join(toolsBin, "gh"),
    `#!/usr/bin/env bash
# Installed by scripts/fork-prepare.mjs. Agent gh policy shim: gates \`gh pr ready\` on the ship gate.
set -euo pipefail
exec node ${JSON.stringify(agentGh)} "$@"
`,
    { encoding: "utf8", mode: 0o755 },
  );
} catch (error) {
  warn("install the agent gh shim", error);
}
