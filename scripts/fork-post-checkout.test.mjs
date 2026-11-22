import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { assert, it } from "@effect/vitest";

const hook = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../.vite-hooks/post-checkout",
);

const withEmit = (fn) => {
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fork-post-checkout-"));
  try {
    NodeChildProcess.execFileSync("git", ["init", "-q"], { cwd: work });
    const files = {
      server: NodePath.join(work, "apps/server/dist/client/index.html"),
      web: NodePath.join(work, "apps/web/dist/gone.txt"),
      pkg: NodePath.join(work, "packages/shared/dist/gone.txt"),
      tsbuildinfo: NodePath.join(work, "packages/shared/tsconfig.tsbuildinfo"),
    };
    for (const file of Object.values(files)) {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, "x");
    }
    const run = (...args) =>
      NodeChildProcess.execFileSync("sh", ["-e", hook, ...args], { cwd: work });
    fn({ files, run });
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
};

it("clears stale emit on a branch checkout but keeps the live-served server dist", () =>
  withEmit(({ files, run }) => {
    run("HEAD", "HEAD", "1");
    assert.isTrue(NodeFS.existsSync(files.server));
    assert.isFalse(NodeFS.existsSync(files.web));
    assert.isFalse(NodeFS.existsSync(files.pkg));
    assert.isFalse(NodeFS.existsSync(files.tsbuildinfo));
  }));

it("leaves file checkouts alone", () =>
  withEmit(({ files, run }) => {
    run("HEAD", "HEAD", "0");
    assert.isTrue(NodeFS.existsSync(files.web));
    assert.isTrue(NodeFS.existsSync(files.tsbuildinfo));
  }));
