import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

const repositoryRoot = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));

// EAS omits desktop and relay workspaces from its archive. Keep their patches
// registered so the full repository stays strict, but allow them to be unused
// during both dependency installs in this smaller remote build workspace.
if (
  process.env.EAS_BUILD === "true" &&
  (!NodeFS.existsSync(`${repositoryRoot}/apps/desktop/package.json`) ||
    !NodeFS.existsSync(`${repositoryRoot}/infra/relay/package.json`))
) {
  const workspacePath = `${repositoryRoot}/pnpm-workspace.yaml`;
  const workspace = NodeFS.readFileSync(workspacePath, "utf8");
  if (!/^allowUnusedPatches:/m.test(workspace)) {
    NodeFS.writeFileSync(workspacePath, `${workspace.trimEnd()}\n\nallowUnusedPatches: true\n`);
  }
}
