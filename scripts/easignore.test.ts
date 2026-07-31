// @effect-diagnostics nodeBuiltinImport:off - Verifies EAS ignore behavior through git's matcher.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

const repositoryRoot = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

function isIgnored(cwd: string, path: string): boolean {
  try {
    NodeChildProcess.execFileSync("git", ["check-ignore", "--no-index", "--quiet", path], {
      cwd,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

describe("EAS archive ignore rules", () => {
  it("keeps mobile native TypeScript sources while excluding root native tooling", () => {
    const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-easignore-"));

    try {
      NodeChildProcess.execFileSync("git", ["init", "--quiet"], {
        cwd: fixtureRoot,
        stdio: "ignore",
      });
      NodeFS.copyFileSync(
        NodePath.join(repositoryRoot, ".easignore"),
        NodePath.join(fixtureRoot, ".gitignore"),
      );

      const rootNativeFile = "native/host.swift";
      const mobileNativeFile = "apps/mobile/src/native/native-glass.ts";
      for (const path of [rootNativeFile, mobileNativeFile]) {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(fixtureRoot, path)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(fixtureRoot, path), "fixture\n");
      }

      expect(isIgnored(fixtureRoot, rootNativeFile)).toBe(true);
      expect(isIgnored(fixtureRoot, mobileNativeFile)).toBe(false);
    } finally {
      NodeFS.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});
