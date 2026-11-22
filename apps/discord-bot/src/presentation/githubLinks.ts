// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

type ExecFileResult = {
  readonly stdout: string;
  readonly stderr: string;
};

type ExecFileLike = (
  file: string,
  args: ReadonlyArray<string>,
  options?: NodeChildProcess.ExecFileOptions,
) => Promise<ExecFileResult>;

interface ParsedPathPosition {
  readonly path: string;
  readonly line?: number | undefined;
}

interface GitHubRepositoryContext {
  readonly repoRoot: string;
  readonly githubUrl: string;
  readonly ref: string;
}

interface CacheEntry<T> {
  readonly expiresAt: number;
  readonly value: Promise<T>;
}

export interface GitHubLinkResolutionCache {
  readonly repositoryRoots: Map<string, CacheEntry<string | null>>;
  readonly repositoryUrls: Map<string, CacheEntry<string | null>>;
  readonly repositoryContexts: Map<string, CacheEntry<GitHubRepositoryContext | null>>;
  readonly trackedPaths: Map<string, CacheEntry<boolean>>;
  readonly now: () => number;
  readonly maxEntries: number;
  readonly repositoryRootTtlMs: number;
  readonly repositoryContextTtlMs: number;
  readonly trackedPathTtlMs: number;
}

const DEFAULT_CACHE_OPTIONS = {
  maxEntries: 2_048,
  repositoryRootTtlMs: 60_000,
  repositoryContextTtlMs: 15_000,
  trackedPathTtlMs: 5_000,
} as const;

export function createGitHubLinkResolutionCache(
  options: Partial<
    Pick<
      GitHubLinkResolutionCache,
      "maxEntries" | "repositoryRootTtlMs" | "repositoryContextTtlMs" | "trackedPathTtlMs" | "now"
    >
  > = {},
): GitHubLinkResolutionCache {
  return {
    repositoryRoots: new Map(),
    repositoryUrls: new Map(),
    repositoryContexts: new Map(),
    trackedPaths: new Map(),
    now: options.now ?? Date.now,
    maxEntries: options.maxEntries ?? DEFAULT_CACHE_OPTIONS.maxEntries,
    repositoryRootTtlMs: options.repositoryRootTtlMs ?? DEFAULT_CACHE_OPTIONS.repositoryRootTtlMs,
    repositoryContextTtlMs:
      options.repositoryContextTtlMs ?? DEFAULT_CACHE_OPTIONS.repositoryContextTtlMs,
    trackedPathTtlMs: options.trackedPathTtlMs ?? DEFAULT_CACHE_OPTIONS.trackedPathTtlMs,
  };
}

const sharedResolutionCache = createGitHubLinkResolutionCache();

function cached<T>(input: {
  readonly entries: Map<string, CacheEntry<T>>;
  readonly key: string;
  readonly ttlMs: number;
  readonly cache: GitHubLinkResolutionCache;
  readonly load: () => Promise<T>;
}): Promise<T> {
  const now = input.cache.now();
  const existing = input.entries.get(input.key);
  if (existing && existing.expiresAt > now) {
    return existing.value;
  }
  if (existing) input.entries.delete(input.key);

  while (input.entries.size >= input.cache.maxEntries) {
    const oldest = input.entries.keys().next().value;
    if (oldest === undefined) break;
    input.entries.delete(oldest);
  }

  const value = input.load();
  input.entries.set(input.key, { expiresAt: now + input.ttlMs, value });
  return value;
}

/**
 * Ensure git is discoverable even when the process PATH is a minimal systemd
 * default that omits environment.systemPackages (common in the microVM units).
 */
export function gitCommandEnv(env: NodeJS.ProcessEnv = globalThis.process.env): NodeJS.ProcessEnv {
  const prefixes = ["/run/current-system/sw/bin", "/usr/bin", "/bin"];
  const current = env.PATH ?? "";
  const merged = [...prefixes, ...current.split(":").filter((part) => part.length > 0)];
  return {
    ...env,
    PATH: [...new Set(merged)].join(":"),
  };
}

function splitPathAndPosition(value: string): ParsedPathPosition {
  let path = value;
  let line: number | undefined;

  const columnMatch = path.match(/:(\d+)$/u);
  if (!columnMatch?.[1]) {
    return { path };
  }

  const trailing = Number.parseInt(columnMatch[1], 10);
  path = path.slice(0, -columnMatch[0].length);

  const lineMatch = path.match(/:(\d+)$/u);
  if (lineMatch?.[1]) {
    line = Number.parseInt(lineMatch[1], 10);
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = trailing;
  }

  return Number.isFinite(line) ? { path, line } : { path };
}

function parsePathReference(value: string): ParsedPathPosition {
  const trimmed = value.trim();
  const rangeMatch =
    /^(?<path>.+?\.[A-Za-z0-9_-]{1,16}):(?<line>\d+)(?:-\d+)?(?:,\d+(?:-\d+)?)*$/u.exec(trimmed);
  if (rangeMatch?.groups?.path && rangeMatch.groups.line) {
    const line = Number.parseInt(rangeMatch.groups.line, 10);
    return Number.isFinite(line) ? { path: rangeMatch.groups.path, line } : { path: trimmed };
  }
  return splitPathAndPosition(trimmed);
}

async function runGit(
  cwd: string,
  args: ReadonlyArray<string>,
  execImpl: ExecFileLike,
): Promise<string | null> {
  try {
    const { stdout } = await execImpl("git", ["-C", cwd, ...args], {
      cwd,
      env: gitCommandEnv(),
    });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

async function resolveRepositoryContext(
  repoRoot: string,
  execImpl: ExecFileLike,
  cache: GitHubLinkResolutionCache | null,
): Promise<GitHubRepositoryContext | null> {
  const githubUrl = await resolveRepositoryGitHubUrl(repoRoot, execImpl, cache);
  if (!githubUrl) {
    return null;
  }

  const sha = await runGit(repoRoot, ["rev-parse", "HEAD"], execImpl);
  if (!sha) {
    return null;
  }

  const branch = await runGit(repoRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"], execImpl);
  if (!branch) {
    return { repoRoot, githubUrl, ref: sha };
  }

  const remoteBranch = await runGit(
    repoRoot,
    ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`],
    execImpl,
  );

  return {
    repoRoot,
    githubUrl,
    ref: remoteBranch ? branch : sha,
  };
}

async function resolveRepositoryGitHubUrl(
  repoRoot: string,
  execImpl: ExecFileLike,
  cache: GitHubLinkResolutionCache | null,
): Promise<string | null> {
  const load = async () => {
    const remoteUrl = await runGit(repoRoot, ["remote", "get-url", "origin"], execImpl);
    return remoteUrl ? normalizeGitHubRemoteUrl(remoteUrl) : null;
  };
  return cache
    ? cached({
        entries: cache.repositoryUrls,
        key: repoRoot,
        ttlMs: cache.repositoryRootTtlMs,
        cache,
        load,
      })
    : load();
}

async function isTrackedRepositoryPath(
  repoRoot: string,
  relativePath: string,
  execImpl: ExecFileLike,
): Promise<boolean> {
  try {
    await execImpl("git", ["-C", repoRoot, "ls-files", "--error-unmatch", "--", relativePath], {
      cwd: repoRoot,
      env: gitCommandEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

function resolutionCache(options: {
  readonly execFile?: ExecFileLike | undefined;
  readonly cache?: GitHubLinkResolutionCache | undefined;
}): GitHubLinkResolutionCache | null {
  if (options.cache) return options.cache;
  // Test/custom executors must never share results with production git calls.
  return options.execFile ? null : sharedResolutionCache;
}

function encodeGitHubPath(value: string): string {
  return value
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildGitHubBlobUrl(input: {
  readonly githubUrl: string;
  readonly ref: string;
  readonly relativePath: string;
  readonly line?: number | undefined;
}): string {
  const refPath = encodeGitHubPath(input.ref);
  const relativePath = encodeGitHubPath(input.relativePath.replaceAll("\\", "/"));
  const hash = input.line !== undefined ? `#L${input.line}` : "";
  return `${input.githubUrl}/blob/${refPath}/${relativePath}${hash}`;
}

export function normalizeGitHubRemoteUrl(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;

  // SCP-like, including deploy-key / machine users (e.g. org-123@github.com:owner/repo).
  const scpLike = /^(?:[\w.-]+@)?github\.com:([^/\s]+)\/(.+?)(?:\.git)?$/u.exec(trimmed);
  if (scpLike) {
    return `https://github.com/${scpLike[1]}/${scpLike[2]}`;
  }

  // ssh:// with optional user and optional port (ssh.github.com is GitHub's HTTPS-port SSH endpoint).
  const sshLike =
    /^ssh:\/\/(?:[\w.-]+@)?(?:github\.com|ssh\.github\.com)(?::\d+)?\/([^/\s]+)\/(.+?)(?:\.git)?$/u.exec(
      trimmed,
    );
  if (sshLike) {
    return `https://github.com/${sshLike[1]}/${sshLike[2]}`;
  }

  try {
    const url = new URL(trimmed);
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com" && host !== "ssh.github.com") {
      return null;
    }
    const path = url.pathname.replace(/\.git$/u, "").replace(/\/+$/u, "");
    if (path === "" || !path.includes("/", 1)) return null;
    return `https://github.com${path}`;
  } catch {
    return null;
  }
}

export async function resolveGitHubBlobUrlForLocalPath(
  filePath: string,
  options?: {
    readonly execFile?: ExecFileLike | undefined;
    readonly repoContextCache?: Map<string, GitHubRepositoryContext | null> | undefined;
    readonly cache?: GitHubLinkResolutionCache | undefined;
  },
): Promise<string | null> {
  const execImpl = options?.execFile ?? execFile;
  const parsed = parsePathReference(filePath);
  if (!NodePath.isAbsolute(parsed.path)) {
    return null;
  }

  const fileDirectory = NodePath.dirname(parsed.path);
  const cache = resolutionCache(options ?? {});
  const repoRoot = cache
    ? await cached({
        entries: cache.repositoryRoots,
        key: fileDirectory,
        ttlMs: cache.repositoryRootTtlMs,
        cache,
        load: () => runGit(fileDirectory, ["rev-parse", "--show-toplevel"], execImpl),
      })
    : await runGit(fileDirectory, ["rev-parse", "--show-toplevel"], execImpl);
  if (!repoRoot) {
    return null;
  }

  const requestCache = options?.repoContextCache;
  const cachedContext = requestCache?.get(repoRoot);
  const context =
    cachedContext !== undefined
      ? cachedContext
      : cache
        ? await cached({
            entries: cache.repositoryContexts,
            key: repoRoot,
            ttlMs: cache.repositoryContextTtlMs,
            cache,
            load: () => resolveRepositoryContext(repoRoot, execImpl, cache),
          })
        : await resolveRepositoryContext(repoRoot, execImpl, null);
  if (cachedContext === undefined) {
    requestCache?.set(repoRoot, context);
  }
  if (!context) {
    return null;
  }

  const relativePath = NodePath.relative(context.repoRoot, parsed.path);
  if (relativePath === "" || relativePath.startsWith("..") || NodePath.isAbsolute(relativePath)) {
    return null;
  }
  const trackedCacheKey = `${context.repoRoot}\0${relativePath}`;
  const tracked = cache
    ? await cached({
        entries: cache.trackedPaths,
        key: trackedCacheKey,
        ttlMs: cache.trackedPathTtlMs,
        cache,
        load: () => isTrackedRepositoryPath(context.repoRoot, relativePath, execImpl),
      })
    : await isTrackedRepositoryPath(context.repoRoot, relativePath, execImpl);
  if (!tracked) {
    return null;
  }

  return buildGitHubBlobUrl({
    githubUrl: context.githubUrl,
    ref: context.ref,
    relativePath,
    line: parsed.line,
  });
}

export async function resolveGitHubBlobUrlForPathReference(
  pathReference: string,
  options?: {
    readonly cwd?: string | undefined;
    readonly execFile?: ExecFileLike | undefined;
    readonly repoContextCache?: Map<string, GitHubRepositoryContext | null> | undefined;
    readonly cache?: GitHubLinkResolutionCache | undefined;
  },
): Promise<string | null> {
  const parsed = parsePathReference(pathReference);
  const absolutePath = NodePath.isAbsolute(parsed.path)
    ? parsed.path
    : options?.cwd
      ? NodePath.resolve(options.cwd, parsed.path)
      : null;
  if (absolutePath === null) {
    return null;
  }

  const suffix = parsed.line !== undefined ? `:${parsed.line}` : "";
  return resolveGitHubBlobUrlForLocalPath(`${absolutePath}${suffix}`, options);
}

export async function resolveGitHubUrlForWorkspace(
  workspaceRoot: string,
  options?: {
    readonly execFile?: ExecFileLike | undefined;
    readonly cache?: GitHubLinkResolutionCache | undefined;
  },
): Promise<string | null> {
  const execImpl = options?.execFile ?? execFile;
  const cache = resolutionCache(options ?? {});
  return resolveRepositoryGitHubUrl(NodePath.resolve(workspaceRoot), execImpl, cache);
}
