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
  it("retains every locked workspace manifest while excluding unrelated workspace sources", () => {
    const fixtureRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-eas-importers-"));
    try {
      NodeChildProcess.execFileSync("git", ["init", "--quiet"], {
        cwd: fixtureRoot,
        stdio: "ignore",
      });
      NodeFS.copyFileSync(
        NodePath.join(repositoryRoot, ".easignore"),
        NodePath.join(fixtureRoot, ".gitignore"),
      );
      const lockfile = NodeFS.readFileSync(NodePath.join(repositoryRoot, "pnpm-lock.yaml"), "utf8");
      const importers = new Set<string>();
      // pnpm 12 can store package-manager and workspace lockfiles as separate YAML documents.
      for (const block of lockfile.matchAll(/^importers:\n([\s\S]*?)(?=^\S|$(?![\s\S]))/gm)) {
        for (const entry of block[1]!.matchAll(/^  (\S[^\n]*):$/gm)) importers.add(entry[1]!);
      }
      expect(importers.size).toBeGreaterThan(1);
      for (const importer of importers) {
        const manifest = importer === "." ? "package.json" : `${importer}/package.json`;
        expect(NodeFS.existsSync(NodePath.join(repositoryRoot, manifest)), manifest).toBe(true);
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(fixtureRoot, manifest)), {
          recursive: true,
        });
        NodeFS.writeFileSync(NodePath.join(fixtureRoot, manifest), "{}\n");
        expect(isIgnored(fixtureRoot, manifest), `frozen-lockfile requires ${manifest}`).toBe(
          false,
        );
      }
      for (const workspace of [
        "apps/desktop",
        "apps/vscode",
        "apps/discord-bot",
        "infra/relay",
        "infra/task-cache",
      ]) {
        const source = `${workspace}/src/archive-omitted.ts`;
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(fixtureRoot, source)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(fixtureRoot, source), "fixture\n");
        expect(isIgnored(fixtureRoot, source), source).toBe(true);
      }
    } finally {
      NodeFS.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });

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

      // EAS filters directory paths without trailing slashes before descending.
      const vendorDirectory = NodePath.join(fixtureRoot, "native/libghostty-vt");
      NodeFS.mkdirSync(NodePath.dirname(vendorDirectory), { recursive: true });
      NodeFS.writeFileSync(vendorDirectory, "directory path fixture");
      expect(isIgnored(fixtureRoot, "native/libghostty-vt")).toBe(false);
      NodeFS.unlinkSync(vendorDirectory);

      const rootNativeFile = "native/host.swift";
      const mobileLicense = "native/libghostty-vt/LICENSE";
      const mobileNativeFile = "apps/mobile/src/native/native-glass.ts";
      for (const path of [rootNativeFile, mobileNativeFile, mobileLicense]) {
        NodeFS.mkdirSync(NodePath.dirname(NodePath.join(fixtureRoot, path)), { recursive: true });
        NodeFS.writeFileSync(NodePath.join(fixtureRoot, path), "fixture\n");
      }

      expect(isIgnored(fixtureRoot, rootNativeFile)).toBe(true);
      expect(isIgnored(fixtureRoot, mobileNativeFile)).toBe(false);
      expect(isIgnored(fixtureRoot, mobileLicense)).toBe(false);
    } finally {
      NodeFS.rmSync(fixtureRoot, { force: true, recursive: true });
    }
  });
});
