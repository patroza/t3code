// @effect-diagnostics nodeBuiltinImport:off - Exercises the release script with a fake GitHub CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";
const script = NodeURL.fileURLToPath(new URL("./dispatch-mobile-releases.sh", import.meta.url));
function run(scenario: string) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mobile-dispatch-"));
  const log = NodePath.join(dir, "calls");
  NodeFS.writeFileSync(
    NodePath.join(dir, "gh"),
    `#!/bin/bash
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1" == api ]]; then
  if [[ "$*" == *production* && "$SCENARIO" == disabled ]]; then echo disabled_manually
  elif [[ "$*" == *production* && "$SCENARIO" == lookup-failed ]]; then exit 1
  else echo active; fi
elif [[ "$*" == *production* && "$SCENARIO" == dispatch-failed ]]; then exit 1
fi
`,
    { mode: 0o755 },
  );
  try {
    const result = NodeChildProcess.spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        CALLS: log,
        SCENARIO: scenario,
        GITHUB_REPOSITORY: "fork/repo",
        RELEASE_REF: "fork/dev",
        RELEASE_SHA: "exact-sha",
      },
    });
    return { ...result, calls: NodeFS.readFileSync(log, "utf8") };
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
}
describe("mobile release dispatch", () => {
  it("skips disabled production and still dispatches development", () => {
    const result = run("disabled");
    expect(result.status).toBe(0);
    expect(result.calls).not.toContain("workflow run mobile-eas-production.yml");
    expect(result.calls).toContain("workflow run mobile-eas-development.yml");
    expect(result.stdout).toContain("disabled_manually");
  });
  it("dispatches both active workflows with the exact source", () => {
    const result = run("active");
    expect(result.status).toBe(0);
    expect(result.calls).toContain("workflow run mobile-eas-production.yml");
    expect(result.calls).toContain("workflow run mobile-eas-development.yml");
    expect(result.calls).toContain("sha=exact-sha");
    expect(result.calls).toContain("mode=auto");
  });
  for (const scenario of ["lookup-failed", "dispatch-failed"]) {
    it(`reports ${scenario} while still trying development`, () => {
      const result = run(scenario);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("ERROR:");
      expect(result.calls).toContain("workflow run mobile-eas-development.yml");
    });
  }
});
