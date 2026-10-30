// @effect-diagnostics nodeBuiltinImport:off - Runs the production workflow's environment validation in a disposable directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/mobile-eas-production.yml", import.meta.url),
  "utf8",
);
const step = workflow
  .split("- name: Pull production environment variables")[1]
  ?.split("- name:")[0];
const validation = step?.match(/<<'NODE'\n([\s\S]*?)\n\s+NODE/)?.[1];

it.each(["ios", "android", "all"])("validates only the selected platform: %s", (platform) => {
  expect(step).toContain("RELEASE_PLATFORM: ${{ inputs.platform }}");
  expect(validation).toBeDefined();
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-production-env-"));
  try {
    NodeFS.writeFileSync(NodePath.join(cwd, ".env.local"), "");
    const result = NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-"], {
      cwd,
      input: validation,
      encoding: "utf8",
      env: { RELEASE_PLATFORM: platform, GITHUB_ENV: NodePath.join(cwd, "github-env") },
    });
    expect(result.status).toBe(platform === "ios" ? 0 : 1);
    if (platform !== "ios")
      expect(result.stderr).toContain("T3CODE_ANDROID_GOOGLE_SERVICES_FILE is missing");
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});

it("exports the Android file when Android is selected", () => {
  const cwd = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-production-env-"));
  const githubEnv = NodePath.join(cwd, "github-env");
  try {
    NodeFS.writeFileSync(
      NodePath.join(cwd, ".env.local"),
      "T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/tmp/firebase.json\n",
    );
    const result = NodeChildProcess.spawnSync(process.execPath, ["--input-type=module", "-"], {
      cwd,
      input: validation,
      encoding: "utf8",
      env: { RELEASE_PLATFORM: "android", GITHUB_ENV: githubEnv },
    });
    expect(result.status).toBe(0);
    expect(NodeFS.readFileSync(githubEnv, "utf8")).toContain(
      "T3CODE_ANDROID_GOOGLE_SERVICES_FILE=/tmp/firebase.json",
    );
  } finally {
    NodeFS.rmSync(cwd, { recursive: true, force: true });
  }
});
