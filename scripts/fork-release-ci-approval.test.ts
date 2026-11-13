// @effect-diagnostics nodeBuiltinImport:off - Exercises the shipped release guard with a fake GitHub CLI.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const sha = "b".repeat(40);
const approved = {
  head_sha: sha,
  head_branch: "fork/dev",
  event: "push",
  status: "completed",
  conclusion: "success",
};
const workflow = NodeFS.readFileSync(
  new URL("../.github/workflows/fork-release.yml", import.meta.url),
  "utf8",
);
const step = workflow
  .split("      - name: Confirm the SHA is green\n")[1]!
  .split("\n      - id: previous")[0]!;
const guard = step
  .split("        run: |\n")[1]!
  .split("\n")
  .map((line) => line.replace(/^          /, ""))
  .join("\n");

function runGuard(runs: ReadonlyArray<unknown>) {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "release-ci-approval-"));
  const calls = NodePath.join(directory, "calls");
  const response = NodePath.join(directory, "runs.json");
  NodeFS.writeFileSync(response, JSON.stringify({ workflow_runs: runs }));
  NodeFS.writeFileSync(
    NodePath.join(directory, "gh"),
    `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> "$CALLS"
query='.'
while [[ $# -gt 0 ]]; do
  if [[ "$1" == --jq ]]; then query="$2"; shift 2; else shift; fi
done
jq "$query" "$RUNS"
`,
    { mode: 0o755 },
  );
  try {
    const result = NodeChildProcess.spawnSync("bash", ["-eu", "-c", guard], {
      encoding: "utf8",
      env: {
        ...process.env,
        BASH_ENV: "/dev/null",
        PATH: `${directory}:${process.env.PATH}`,
        CALLS: calls,
        RUNS: response,
        GITHUB_REPOSITORY: "fork/repo",
        RELEASE_REF: "fork/dev",
        RELEASE_SHA: sha,
      },
    });
    return { ...result, calls: NodeFS.readFileSync(calls, "utf8") };
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

describe("Fork Release exact CI approval", () => {
  it.each([
    { conclusion: "failure" },
    { conclusion: "cancelled" },
    { status: "in_progress", conclusion: null },
    { head_sha: "a".repeat(40) },
    { event: "pull_request" },
    { head_branch: "main" },
  ])("rejects an unapproved run: %j", (changes) => {
    const result = runGuard([{ ...approved, ...changes }]);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("no successful Fork CI push run");
  });

  it("accepts the exact successful push without relying on GitHub's success filter", () => {
    const result = runGuard([{ ...approved, head_sha: "a".repeat(40) }, approved]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(`Fork CI is green for ${sha}`);
    expect(result.calls).toContain("repos/fork/repo/actions/workflows/fork-ci.yml/runs");
    expect(result.calls).toContain(`head_sha=${sha}`);
    expect(result.calls).toContain("event=push");
    expect(result.calls).toContain("branch=fork/dev");
    expect(result.calls).not.toContain("status=success");
  });
});
