// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { diskBackedWorkRoot, mkdtempDiskBacked } from "./disk-backed-tmp.ts";

describe("diskBackedWorkRoot", () => {
  it("prefers explicit env var", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "disk-backed-env-"));
    const prev = process.env.T3_REBASE_WORK_ROOT;
    process.env.T3_REBASE_WORK_ROOT = dir;
    try {
      expect(diskBackedWorkRoot({ subdir: "rebase-work", envVar: "T3_REBASE_WORK_ROOT" })).toBe(
        dir,
      );
    } finally {
      if (prev === undefined) delete process.env.T3_REBASE_WORK_ROOT;
      else process.env.T3_REBASE_WORK_ROOT = prev;
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("mkdtempDiskBacked creates a unique directory under the work root", () => {
    const root = diskBackedWorkRoot({ subdir: "rebase-work", envVar: "T3_REBASE_WORK_ROOT" });
    const a = mkdtempDiskBacked("rebase-pr-stack-", {
      subdir: "rebase-work",
      envVar: "T3_REBASE_WORK_ROOT",
    });
    const b = mkdtempDiskBacked("rebase-pr-stack-", {
      subdir: "rebase-work",
      envVar: "T3_REBASE_WORK_ROOT",
    });
    expect(a).not.toBe(b);
    expect(a.startsWith(root)).toBe(true);
    expect(NodeFS.statSync(a).isDirectory()).toBe(true);
    NodeFS.rmSync(a, { recursive: true, force: true });
    NodeFS.rmSync(b, { recursive: true, force: true });
  });
});
