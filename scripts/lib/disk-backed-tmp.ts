// @effect-diagnostics nodeBuiltinImport:off
/**
 * Disk-backed work roots for multi-GB tooling (stack rebase, compose, clones).
 *
 * `/tmp` is often tmpfs (host Arch) or the guest's RAM rootfs (t3vm). Putting full
 * git workdirs there OOMs or fills root. Prefer HOME/.t3/<subdir> (or T3CODE_HOME
 * when that is the data volume), with TMPDIR only if it is not a tmpfs.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

function isTmpfsPath(dir: string): boolean {
  try {
    // Linux: /proc/mounts. Best-effort — if unreadable, assume not tmpfs.
    const mounts = NodeFS.readFileSync("/proc/mounts", "utf8");
    let bestLen = -1;
    let bestFs = "";
    const resolved = NodeFS.realpathSync(dir);
    for (const line of mounts.split("\n")) {
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      const mountPoint = parts[1]!;
      const fsType = parts[2]!;
      if (
        (resolved === mountPoint ||
          resolved.startsWith(mountPoint.endsWith("/") ? mountPoint : `${mountPoint}/`)) &&
        mountPoint.length > bestLen
      ) {
        bestLen = mountPoint.length;
        bestFs = fsType;
      }
    }
    return bestFs === "tmpfs" || bestFs === "ramfs";
  } catch {
    return false;
  }
}

function tryMkdir(dir: string): boolean {
  try {
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.accessSync(dir, NodeFS.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a durable work root for heavy temporary trees.
 *
 * Order:
 * 1. `envVar` if set (e.g. T3_REBASE_WORK_ROOT)
 * 2. `$T3CODE_HOME/<subdir>` when T3CODE_HOME is set (t3vm: /var/lib/t3)
 * 3. `$HOME/.t3/<subdir>`
 * 4. `$TMPDIR` only if not tmpfs
 * 5. `os.tmpdir()` last resort
 */
export function diskBackedWorkRoot(options: {
  readonly subdir: string;
  readonly envVar?: string;
}): string {
  const fromEnv = options.envVar ? process.env[options.envVar]?.trim() : undefined;
  if (fromEnv && tryMkdir(fromEnv)) {
    return fromEnv;
  }

  const t3Home = process.env.T3CODE_HOME?.trim();
  if (t3Home) {
    const candidate = NodePath.join(t3Home, options.subdir);
    if (tryMkdir(candidate)) return candidate;
  }

  const home = process.env.HOME?.trim() || NodeOS.homedir();
  if (home) {
    const candidate = NodePath.join(home, ".t3", options.subdir);
    if (tryMkdir(candidate)) return candidate;
  }

  const tmpDir = process.env.TMPDIR?.trim();
  if (tmpDir && !isTmpfsPath(tmpDir) && tryMkdir(tmpDir)) {
    return tmpDir;
  }

  const osTmp = NodeOS.tmpdir();
  if (!isTmpfsPath(osTmp) && tryMkdir(osTmp)) {
    return osTmp;
  }

  // Last resort: still create under preferred home path even if access check was flaky.
  const fallback = NodePath.join(home || "/tmp", ".t3", options.subdir);
  NodeFS.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** `mkdtemp` under {@link diskBackedWorkRoot} (prefix should end with `-`). */
export function mkdtempDiskBacked(
  prefix: string,
  options: { readonly subdir: string; readonly envVar?: string },
): string {
  const root = diskBackedWorkRoot(options);
  return NodeFS.mkdtempSync(NodePath.join(root, prefix));
}
