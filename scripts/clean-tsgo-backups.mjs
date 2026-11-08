// Remove accumulated tsgo patch backups before prepare; use only Node builtins before dependencies load.
import * as NodeFS from "node:fs";

const backups = NodeFS.globSync(
  "node_modules/.pnpm/@typescript+{native-preview-*,typescript-*}/node_modules/@typescript/{native-preview-*,typescript-*}/lib/{tsgo,tsc}{,.exe}.original*",
);

for (const backup of backups) {
  NodeFS.rmSync(backup, { force: true });
}

if (backups.length > 0) {
  console.log(`Removed ${backups.length} stale tsgo backup(s)`);
}
