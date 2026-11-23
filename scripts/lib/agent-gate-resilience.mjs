/**
 * Keeps the local gate's verdict about the code, not the machine: flaky browser files under load
 * rerun once, and on systemd hosts the full gate runs in its own user unit so a server restart
 * (a deploy) only kills the process waiting on it.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

/**
 * Test files a Vitest JSON report marks failed, including files that failed to import.
 * @param {{ testResults?: ReadonlyArray<{ name?: string, status?: string }> } | null | undefined} report
 * @returns {string[]}
 */
export const failedTestFiles = (report) =>
  (report?.testResults ?? [])
    .filter((result) => result.status === "failed" && typeof result.name === "string")
    .map((result) => /** @type {string} */ (result.name));

/**
 * Runs a Vitest step; on failure reruns only its failed files once (or the whole step when the
 * report names none, e.g. a crash before any file ran). Returns the final exit status.
 * @param {{ label: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, reportPath: string }} input
 * @returns {number}
 */
export const runWithFlakyRerun = ({ label, args, cwd, env, reportPath }) => {
  NodeFS.rmSync(reportPath, { force: true });
  const first = spawnStatus(
    [...args, "--reporter=default", "--reporter=json", `--outputFile.json=${reportPath}`],
    { cwd, env },
  );
  if (first === 0) return 0;

  const files = failedTestFiles(readJson(reportPath)).map((file) => NodePath.relative(cwd, file));
  console.error(
    files.length > 0
      ? `agent ship-gate: ${label} failed in ${files.length} file(s); rerunning them once: ${files.join(", ")}`
      : `agent ship-gate: ${label} failed before naming a file; rerunning the step once`,
  );
  const second = spawnStatus([...args, ...files], { cwd, env });
  if (second === 0) {
    console.error(
      `agent ship-gate: ${label} passed on rerun — flaky under load here, fix them: ${files.join(", ") || "(startup failure)"}`,
    );
  }
  return second;
};

/**
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv }} opts
 */
const spawnStatus = (args, { cwd, env }) => {
  const result = NodeChildProcess.spawnSync(args[0] ?? "", args.slice(1), {
    stdio: "inherit",
    cwd,
    env,
  });
  return result.status === null ? 1 : result.status;
};

/** @param {string} path */
const readJson = (path) => {
  try {
    return JSON.parse(NodeFS.readFileSync(path, "utf8"));
  } catch {
    return null;
  }
};

/**
 * Detach only for agents on a host with a running systemd user manager. AGENT_SHIP_GATE_INLINE=1
 * opts out; CI never detaches.
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} [platform]
 */
export const shouldDetachGate = (env, platform = NodeProcess.platform) => {
  if (platform !== "linux" || env["CI"] || env["AGENT_SHIP_GATE_INLINE"] === "1") return false;
  if (env["AGENT_SHIP_GATE_DETACHED"] === "1") return false;
  const state = NodeChildProcess.spawnSync("systemctl", ["--user", "is-system-running"], {
    encoding: "utf8",
  });
  return ["running", "degraded"].includes((state.stdout ?? "").trim());
};

/** @param {string} tree */
const gateUnitName = (tree) => `agent-gate-${tree.slice(0, 12)}`;

/** @param {string} unit */
const unitIsRunning = (unit) => {
  const state = NodeChildProcess.spawnSync("systemctl", ["--user", "is-active", unit], {
    encoding: "utf8",
  });
  return ["active", "activating"].includes((state.stdout ?? "").trim());
};

/**
 * Runs `entry --detached-gate <envFile> <resultFile>` in a transient user unit named for the tree
 * (or attaches to the one already running), streams its log, and returns its recorded result.
 * @param {{ root: string, tree: string, entry: string, env: NodeJS.ProcessEnv, force: boolean }} input
 * @returns {Promise<{ code: number, gate: unknown }>}
 */
export const runGateDetached = async ({ root, tree, entry, env, force }) => {
  const runDir = NodePath.join(root, ".run");
  NodeFS.mkdirSync(runDir, { recursive: true });
  const unit = gateUnitName(tree);
  const logPath = NodePath.join(runDir, `${unit}.log`);
  const resultPath = NodePath.join(runDir, `${unit}.result.json`);

  if (unitIsRunning(unit)) {
    console.error(`agent ship-gate: attaching to the running gate ${unit} (${logPath})`);
  } else {
    NodeFS.rmSync(resultPath, { force: true });
    NodeFS.writeFileSync(logPath, "");
    const envPath = NodePath.join(runDir, `${unit}.env.json`);
    NodeFS.writeFileSync(envPath, JSON.stringify({ ...env, AGENT_SHIP_GATE_DETACHED: "1" }), {
      mode: 0o600,
    });
    const started = NodeChildProcess.spawnSync(
      "systemd-run",
      [
        "--user",
        "--collect",
        "--quiet",
        `--unit=${unit}`,
        `--working-directory=${root}`,
        "-p",
        `StandardOutput=append:${logPath}`,
        "-p",
        `StandardError=append:${logPath}`,
        NodeProcess.execPath,
        entry,
        "--detached-gate",
        envPath,
        resultPath,
        ...(force ? ["--no-cache"] : []),
      ],
      { encoding: "utf8" },
    );
    if (started.status !== 0) {
      NodeFS.rmSync(envPath, { force: true });
      throw new Error(`systemd-run failed: ${(started.stderr ?? "").trim()}`);
    }
    console.error(
      `agent ship-gate: running in ${unit}, which survives a server restart; log ${logPath}`,
    );
  }

  let offset = 0;
  for (;;) {
    offset = streamFrom(logPath, offset);
    const result = readJson(resultPath);
    if (result !== null) {
      streamFrom(logPath, offset);
      return { code: typeof result.code === "number" ? result.code : 1, gate: result.gate };
    }
    if (!unitIsRunning(unit)) {
      streamFrom(logPath, offset);
      const late = readJson(resultPath);
      if (late !== null) return { code: late.code ?? 1, gate: late.gate };
      return { code: 1, gate: null };
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
};

/**
 * @param {string} path
 * @param {number} offset
 */
const streamFrom = (path, offset) => {
  let size = 0;
  try {
    size = NodeFS.statSync(path).size;
  } catch {
    return offset;
  }
  if (size <= offset) return offset;
  const fd = NodeFS.openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - offset);
    NodeFS.readSync(fd, buffer, 0, buffer.length, offset);
    NodeProcess.stderr.write(buffer);
  } finally {
    NodeFS.closeSync(fd);
  }
  return size;
};

/**
 * Entry inside the unit: restore the caller's environment; the exit code and gate result are
 * written to `resultPath` on exit, for the process attached to the unit.
 * @param {{ envPath: string, resultPath: string }} input
 * @returns {{ env: NodeJS.ProcessEnv, recordGate: (gate: unknown) => void }}
 */
export const enterDetachedGate = ({ envPath, resultPath }) => {
  const env = JSON.parse(NodeFS.readFileSync(envPath, "utf8"));
  NodeFS.rmSync(envPath, { force: true });
  let gate = /** @type {unknown} */ (null);
  NodeProcess.default.on("exit", (code) => {
    NodeFS.writeFileSync(resultPath, JSON.stringify({ code, gate }));
  });
  return { env, recordGate: (value) => (gate = value) };
};
