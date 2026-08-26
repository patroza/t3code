import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../..",
);
const hook = NodePath.join(repoRoot, ".githooks", "post-checkout");

it("keeps apps/server/dist/client across a branch checkout wipe", () => {
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "post-checkout-server-dist-"));
  try {
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: work });
    const serverIndex = NodePath.join(work, "apps/server/dist/client/index.html");
    const webGone = NodePath.join(work, "apps/web/dist/gone.txt");
    const packageGone = NodePath.join(work, "packages/shared/dist/gone.txt");
    NodeFS.mkdirSync(NodePath.dirname(serverIndex), { recursive: true });
    NodeFS.writeFileSync(serverIndex, "<html>live spa</html>");
    NodeFS.mkdirSync(NodePath.dirname(webGone), { recursive: true });
    NodeFS.writeFileSync(webGone, "wipe me");
    NodeFS.mkdirSync(NodePath.dirname(packageGone), { recursive: true });
    NodeFS.writeFileSync(packageGone, "wipe me");

    NodeChildProcess.execFileSync("sh", [hook, "HEAD", "HEAD", "1"], { cwd: work });

    assert.isTrue(
      NodeFS.existsSync(serverIndex),
      "post-checkout must not delete apps/server/dist (live-served web assets)",
    );
    assert.isFalse(NodeFS.existsSync(webGone), "other apps/*/dist should still clear");
    assert.isFalse(NodeFS.existsSync(packageGone), "packages/*/dist should still clear");
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
});
