// This leaf adapter is promise-based so callers can inject it without adding process services to routers.
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

type ExecFile = (file: string, args: ReadonlyArray<string>) => Promise<{ readonly stdout: string }>;

async function gitOutput(cwd: string, args: ReadonlyArray<string>, run: ExecFile): Promise<string> {
  const result = await run("git", ["-C", cwd, ...args]);
  return result.stdout.trim();
}

function remoteHeadBranch(value: string): string | null {
  const prefix = "refs/remotes/origin/";
  return value.startsWith(prefix) && value.length > prefix.length
    ? value.slice(prefix.length)
    : null;
}

export async function resolveWorktreeBaseBranch(input: {
  readonly workspaceRoot: string;
  readonly override?: string | undefined;
  readonly execFile?: ExecFile | undefined;
}): Promise<string> {
  if (input.override?.trim()) return input.override.trim();

  const run = input.execFile ?? execFile;
  try {
    const originHead = await gitOutput(
      input.workspaceRoot,
      ["symbolic-ref", "refs/remotes/origin/HEAD"],
      run,
    );
    const branch = remoteHeadBranch(originHead);
    if (branch !== null) return branch;
  } catch {
    // Bare mirrors often have no origin/HEAD; their own HEAD names the default branch.
  }

  try {
    const isBare = await gitOutput(input.workspaceRoot, ["rev-parse", "--is-bare-repository"], run);
    if (isBare === "true") {
      const head = await gitOutput(input.workspaceRoot, ["symbolic-ref", "HEAD"], run);
      const prefix = "refs/heads/";
      if (head.startsWith(prefix) && head.length > prefix.length) return head.slice(prefix.length);
    }
  } catch {
    // The caller gets the conventional fallback when repository discovery is unavailable.
  }

  return "main";
}
