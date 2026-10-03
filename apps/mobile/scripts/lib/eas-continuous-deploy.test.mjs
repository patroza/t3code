import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vitest";

const script = NodeURL.fileURLToPath(new URL("../eas-continuous-deploy.sh", import.meta.url));
function run(scenario) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "eas-deploy-test-"));
  const log = NodePath.join(dir, "calls");
  NodeFS.writeFileSync(
    NodePath.join(dir, "eas"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
case "$1" in
 fingerprint:generate) echo '{"hash":"runtime"}' ;;
 build:list)
   if [[ "$*" == *"--status finished"* ]]; then echo '[{"runtimeVersion":"old"}]'
   elif [[ "$SCENARIO" == existing* ]]; then echo '[{"id":"exact-build","status":"IN_QUEUE"}]'
   else echo '[]'; fi ;;
 build:view)
   case "$SCENARIO" in
     existing-success) echo '{"id":"exact-build","status":"FINISHED"}' ;;
     existing-wrong) echo '{"id":"other","status":"FINISHED"}' ;;
     existing-timeout) echo '{"id":"exact-build","status":"IN_PROGRESS"}' ;;
     *) echo '{"id":"exact-build","status":"ERRORED"}' ;;
   esac ;;
 build) [[ "$*" == *"--wait"* ]] || exit 99; [[ "$SCENARIO" != new-failed ]] ;;
 update) exit 0 ;;
 *) exit 98 ;;
esac
`,
    { mode: 0o755 },
  );
  try {
    const result = NodeChildProcess.spawnSync(
      "bash",
      [script, "--profile", "production", "--channel", "production", "--auto-submit"],
      {
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          CALLS: log,
          SCENARIO: scenario,
          EAS_BUILD_WAIT_SECONDS: "1",
          EAS_BUILD_POLL_SECONDS: "0.1",
        },
        encoding: "utf8",
        timeout: 5000,
      },
    );
    return { ...result, calls: NodeFS.readFileSync(log, "utf8") };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
describe("native deployment completion", () => {
  it("waits for new builds and auto-submit before publishing OTA", () => {
    const result = run("new-success");
    expect(result.status).toBe(0);
    expect(result.calls).toContain("--wait --auto-submit");
    expect(result.calls).toContain("update");
  });
  it("keeps a failed build or submission red after useful fallback OTA", () => {
    const result = run("new-failed");
    expect(result.status).toBe(1);
    expect(result.calls).toContain("update");
    expect(result.stderr).toContain("required native build did not complete");
  });
  it("waits on the exact existing build", () => {
    const result = run("existing-success");
    expect(result.status).toBe(0);
    expect(result.calls).toContain("build:view exact-build --json");
    expect(result.calls).not.toContain("build --platform");
  });
  for (const scenario of ["existing-failed", "existing-wrong", "existing-timeout"]) {
    it(`rejects ${scenario} while keeping fallback OTA useful`, () => {
      const result = run(scenario);
      expect(result.status).toBe(1);
      expect(result.calls).toContain("update");
    });
  }
});
