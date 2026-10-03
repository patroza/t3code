// @effect-diagnostics nodeBuiltinImport:off - Verifies the dependency-free EAS hook in isolated archives.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

const repositoryRoot = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

it.each([
  { name: "local checkout", easBuild: "false", consumersPresent: false, installSucceeds: false },
  { name: "full EAS checkout", easBuild: "true", consumersPresent: true, installSucceeds: false },
  { name: "partial EAS archive", easBuild: "true", consumersPresent: false, installSucceeds: true },
])(
  "keeps patch registration and validates unused patches in $name",
  ({ easBuild, consumersPresent, installSucceeds }) => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-eas-hook-"));
    try {
      const script = NodePath.join(root, "apps/mobile/scripts/eas-build-pre-install.mjs");
      NodeFS.mkdirSync(NodePath.dirname(script), { recursive: true });
      NodeFS.copyFileSync(
        NodePath.join(repositoryRoot, "apps/mobile/scripts/eas-build-pre-install.mjs"),
        script,
      );
      NodeFS.writeFileSync(
        NodePath.join(root, "package.json"),
        JSON.stringify({ name: "eas-fixture", private: true }),
      );
      const patchRegistration = "patchedDependencies:\n  absent@1.0.0: absent.patch\n";
      NodeFS.writeFileSync(NodePath.join(root, "pnpm-workspace.yaml"), patchRegistration);
      NodeFS.writeFileSync(NodePath.join(root, "absent.patch"), "");
      if (consumersPresent) {
        for (const path of ["apps/desktop/package.json", "infra/relay/package.json"]) {
          NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, path)), { recursive: true });
          NodeFS.writeFileSync(NodePath.join(root, path), "{}");
        }
      }
      const env = { ...process.env, EAS_BUILD: easBuild };
      NodeChildProcess.execFileSync(process.execPath, [script], { env });
      NodeChildProcess.execFileSync(process.execPath, [script], { env });
      const workspace = NodeFS.readFileSync(NodePath.join(root, "pnpm-workspace.yaml"), "utf8");
      expect(workspace).toContain(patchRegistration);
      expect(workspace.match(/allowUnusedPatches:/g)?.length ?? 0).toBe(installSucceeds ? 1 : 0);
      const result = NodeChildProcess.spawnSync(
        "pnpm",
        ["install", "--offline", "--ignore-scripts", "--no-frozen-lockfile"],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status === 0).toBe(installSucceeds);
      if (!installSucceeds) expect(result.stdout).toContain("ERR_PNPM_UNUSED_PATCH");
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

it("runs the hook before EAS installs dependencies", () => {
  const manifest = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, "apps/mobile/package.json"), "utf8"),
  );
  expect(manifest.scripts["eas-build-pre-install"]).toBe("node scripts/eas-build-pre-install.mjs");
});

it("uses the same development runtime policy in CI and the remote build profile", () => {
  const profiles = JSON.parse(
    NodeFS.readFileSync(NodePath.join(repositoryRoot, "apps/mobile/eas.json"), "utf8"),
  );
  const workflow = NodeFS.readFileSync(
    NodePath.join(repositoryRoot, ".github/workflows/mobile-eas-development.yml"),
    "utf8",
  );
  expect(workflow).toMatch(/MOBILE_VERSION_POLICY: fingerprint/);
  expect(profiles.build.development.env.MOBILE_VERSION_POLICY).toBe("fingerprint");
});

it("loads native TypeScript modules while collecting Expo config fingerprint sources", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-expo-loader-"));
  try {
    NodeFS.writeFileSync(NodePath.join(root, "package.json"), '{"type":"module"}');
    const modulePath = NodePath.join(root, "runtime-policy.ts");
    NodeFS.writeFileSync(modulePath, 'export const runtimePolicy = "fingerprint" as const;');
    const mobileRequire = NodeModule.createRequire(
      NodePath.join(repositoryRoot, "apps/mobile/package.json"),
    );
    const updatesRequire = NodeModule.createRequire(
      mobileRequire.resolve("expo-updates/package.json"),
    );
    const loaderPath = updatesRequire.resolve("@expo/fingerprint/build/ExpoConfigLoader.js");
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      [
        "-e",
        `
      const { installModuleCaptureHook } = require(process.argv[1]);
      const hook = installModuleCaptureHook();
      try {
        const config = require(process.argv[2]);
        console.log(JSON.stringify({ runtimePolicy: config.runtimePolicy, captured: hook.getCapturedModules().some(module => module.filename === process.argv[2]) }));
      } finally { hook.uninstall(); }
    `,
        loaderPath,
        modulePath,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual({ runtimePolicy: "fingerprint", captured: true });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
