// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const PROFILE_NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export interface BrowserProfileMetadata {
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly setupUrl?: string;
  readonly verifyUrl?: string;
  readonly expectUrl?: string;
  readonly verifiedAt?: string;
  readonly browserExecutablePath: string;
}

interface LockOwner {
  readonly pid: number;
  readonly startedAt: string;
}

export interface BrowserProfilePaths {
  readonly root: string;
  readonly userDataDir: string;
  readonly metadataPath: string;
  readonly lockDir: string;
}

export class BrowserProfileError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BrowserProfileError";
  }
}

export function expandHome(input: string): string {
  if (input === "~") return NodeOS.homedir();
  if (input.startsWith("~/")) return NodePath.join(NodeOS.homedir(), input.slice(2));
  return NodePath.resolve(input);
}

export function validateProfileName(name: string): string {
  if (!PROFILE_NAME.test(name)) {
    throw new BrowserProfileError(
      "Profile names must be 1-64 lowercase letters, numbers, or hyphens.",
    );
  }
  return name;
}

export function profilePaths(dataDir: string, name: string): BrowserProfilePaths {
  const safeName = validateProfileName(name);
  const root = NodePath.join(expandHome(dataDir), "browser", "profiles", safeName);
  return {
    root,
    userDataDir: NodePath.join(root, "user-data"),
    metadataPath: NodePath.join(root, "profile.json"),
    lockDir: NodePath.join(expandHome(dataDir), "browser", "locks", `${safeName}.lock`),
  };
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await NodeFSP.access(target, NodeFS.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLockOwner(lockDir: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(
      await NodeFSP.readFile(NodePath.join(lockDir, "owner.json"), "utf8"),
    ) as {
      pid?: unknown;
      startedAt?: unknown;
    };
    return typeof value.pid === "number" && typeof value.startedAt === "string"
      ? { pid: value.pid, startedAt: value.startedAt }
      : null;
  } catch {
    return null;
  }
}

export async function acquireProfileLock(paths: BrowserProfilePaths): Promise<() => Promise<void>> {
  await NodeFSP.mkdir(NodePath.dirname(paths.lockDir), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await NodeFSP.mkdir(paths.lockDir, { mode: 0o700 });
      await NodeFSP.writeFile(
        NodePath.join(paths.lockDir, "owner.json"),
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        { mode: 0o600 },
      );
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await NodeFSP.rm(paths.lockDir, { recursive: true, force: true });
      };
    } catch (cause) {
      const error = cause as NodeJS.ErrnoException;
      if (error.code !== "EEXIST") {
        throw new BrowserProfileError(
          `Could not lock browser profile ${NodePath.basename(paths.root)}.`,
          {
            cause,
          },
        );
      }
      const owner = await readLockOwner(paths.lockDir);
      if (attempt === 0 && owner !== null && !isProcessAlive(owner.pid)) {
        await NodeFSP.rm(paths.lockDir, { recursive: true, force: true });
        continue;
      }
      const ownerDescription = owner
        ? `PID ${owner.pid} since ${owner.startedAt}`
        : "an unknown process";
      throw new BrowserProfileError(
        `Browser profile ${NodePath.basename(paths.root)} is in use by ${ownerDescription}.`,
      );
    }
  }
  throw new BrowserProfileError(`Could not lock browser profile ${NodePath.basename(paths.root)}.`);
}

export async function ensureProfileDirectories(paths: BrowserProfilePaths): Promise<void> {
  await NodeFSP.mkdir(paths.userDataDir, { recursive: true, mode: 0o700 });
  await NodeFSP.chmod(paths.root, 0o700);
  await NodeFSP.chmod(paths.userDataDir, 0o700);
}

export async function readProfileMetadata(
  paths: BrowserProfilePaths,
): Promise<BrowserProfileMetadata> {
  try {
    return JSON.parse(await NodeFSP.readFile(paths.metadataPath, "utf8")) as BrowserProfileMetadata;
  } catch (cause) {
    throw new BrowserProfileError(
      `Browser profile ${NodePath.basename(paths.root)} is not set up. Run browser-profile setup first.`,
      { cause },
    );
  }
}

export async function writeProfileMetadata(
  paths: BrowserProfilePaths,
  metadata: BrowserProfileMetadata,
): Promise<void> {
  await ensureProfileDirectories(paths);
  const temporary = `${paths.metadataPath}.${process.pid}.tmp`;
  await NodeFSP.writeFile(temporary, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  await NodeFSP.rename(temporary, paths.metadataPath);
}

export async function listProfiles(
  dataDir: string,
): Promise<ReadonlyArray<BrowserProfileMetadata>> {
  const profilesDir = NodePath.join(expandHome(dataDir), "browser", "profiles");
  if (!(await pathExists(profilesDir))) return [];
  const entries = await NodeFSP.readdir(profilesDir, { withFileTypes: true });
  const profiles = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && PROFILE_NAME.test(entry.name))
      .map(async (entry) => {
        try {
          return await readProfileMetadata(profilePaths(dataDir, entry.name));
        } catch {
          return null;
        }
      }),
  );
  return profiles.filter((profile): profile is BrowserProfileMetadata => profile !== null);
}

export async function clearProfile(dataDir: string, name: string): Promise<void> {
  const paths = profilePaths(dataDir, name);
  const release = await acquireProfileLock(paths);
  try {
    await NodeFSP.rm(paths.root, { recursive: true, force: true });
  } finally {
    await release();
  }
}
