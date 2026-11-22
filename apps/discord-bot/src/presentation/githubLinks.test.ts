import { describe, expect, it } from "vite-plus/test";
import {
  createGitHubLinkResolutionCache,
  normalizeGitHubRemoteUrl,
  resolveGitHubBlobUrlForLocalPath,
  resolveGitHubBlobUrlForPathReference,
  resolveGitHubUrlForWorkspace,
} from "./githubLinks.ts";

describe("normalizeGitHubRemoteUrl", () => {
  it("normalizes GitHub SSH remotes", () => {
    expect(normalizeGitHubRemoteUrl("git@github.com:pingdotgg/t3code.git")).toBe(
      "https://github.com/pingdotgg/t3code",
    );
    expect(normalizeGitHubRemoteUrl("ssh://git@github.com/pingdotgg/t3code.git")).toBe(
      "https://github.com/pingdotgg/t3code",
    );
  });

  it("normalizes GitHub deploy-key style SCP remotes", () => {
    expect(normalizeGitHubRemoteUrl("org-12345678@github.com:pingdotgg/t3code.git")).toBe(
      "https://github.com/pingdotgg/t3code",
    );
  });

  it("normalizes GitHub HTTPS remotes", () => {
    expect(normalizeGitHubRemoteUrl("https://github.com/pingdotgg/t3code.git")).toBe(
      "https://github.com/pingdotgg/t3code",
    );
    expect(normalizeGitHubRemoteUrl("https://www.github.com/pingdotgg/t3code.git")).toBe(
      "https://github.com/pingdotgg/t3code",
    );
  });

  it("rejects non-GitHub remotes", () => {
    expect(normalizeGitHubRemoteUrl("https://gitlab.com/pingdotgg/t3code.git")).toBeNull();
  });
});

describe("resolveGitHubBlobUrlForLocalPath", () => {
  it("uses the remote branch when origin already has it", async () => {
    const execFile = async (_file: string, args: ReadonlyArray<string>) => {
      const key = args.slice(2).join(" ");
      switch (key) {
        case "rev-parse --show-toplevel":
          return { stdout: "/repo\n", stderr: "" };
        case "remote get-url origin":
          return { stdout: "git@github.com:pingdotgg/t3code.git\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "deadbeefcafebabe\n", stderr: "" };
        case "symbolic-ref --quiet --short HEAD":
          return { stdout: "feature/code-links\n", stderr: "" };
        case "rev-parse --verify --quiet refs/remotes/origin/feature/code-links":
          return { stdout: "deadbeefcafebabe\n", stderr: "" };
        case "ls-files --error-unmatch -- apps/server/src/index.ts":
          return { stdout: "apps/server/src/index.ts\n", stderr: "" };
        default:
          throw new Error(`Unexpected git call: ${key}`);
      }
    };

    await expect(
      resolveGitHubBlobUrlForLocalPath("/repo/apps/server/src/index.ts:42", { execFile }),
    ).resolves.toBe(
      "https://github.com/pingdotgg/t3code/blob/feature/code-links/apps/server/src/index.ts#L42",
    );
  });

  it("falls back to the current commit sha for detached or local-only worktree refs", async () => {
    const execFile = async (_file: string, args: ReadonlyArray<string>) => {
      const key = args.slice(2).join(" ");
      switch (key) {
        case "rev-parse --show-toplevel":
          return { stdout: "/repo\n", stderr: "" };
        case "remote get-url origin":
          return { stdout: "https://github.com/pingdotgg/t3code.git\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "abc123def456\n", stderr: "" };
        case "symbolic-ref --quiet --short HEAD":
          return { stdout: "t3code/1dd39f28\n", stderr: "" };
        case "rev-parse --verify --quiet refs/remotes/origin/t3code/1dd39f28":
          throw new Error("missing remote branch");
        case "ls-files --error-unmatch -- packages/contracts/src/settings.ts":
          return { stdout: "packages/contracts/src/settings.ts\n", stderr: "" };
        default:
          throw new Error(`Unexpected git call: ${key}`);
      }
    };

    await expect(
      resolveGitHubBlobUrlForLocalPath("/repo/packages/contracts/src/settings.ts:316", {
        execFile,
      }),
    ).resolves.toBe(
      "https://github.com/pingdotgg/t3code/blob/abc123def456/packages/contracts/src/settings.ts#L316",
    );
  });

  it("returns null for files outside a GitHub-backed repo", async () => {
    const execFile = async (_file: string, args: ReadonlyArray<string>) => {
      const key = args.slice(2).join(" ");
      if (key === "rev-parse --show-toplevel") {
        return { stdout: "/repo\n", stderr: "" };
      }
      if (key === "remote get-url origin") {
        return { stdout: "https://gitlab.com/pingdotgg/t3code.git\n", stderr: "" };
      }
      if (key === "rev-parse HEAD") {
        return { stdout: "abc123def456\n", stderr: "" };
      }
      throw new Error(`Unexpected git call: ${key}`);
    };

    await expect(resolveGitHubBlobUrlForLocalPath("/repo/file.ts:1", { execFile })).resolves.toBe(
      null,
    );
  });

  it("reuses cached repo context across multiple files in one repo", async () => {
    let remoteCallCount = 0;
    const execFile = async (_file: string, args: ReadonlyArray<string>) => {
      const key = args.slice(2).join(" ");
      switch (key) {
        case "rev-parse --show-toplevel":
          return { stdout: "/repo\n", stderr: "" };
        case "remote get-url origin":
          remoteCallCount += 1;
          return { stdout: "git@github.com:pingdotgg/t3code.git\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "abc123def456\n", stderr: "" };
        case "symbolic-ref --quiet --short HEAD":
          return { stdout: "main\n", stderr: "" };
        case "rev-parse --verify --quiet refs/remotes/origin/main":
          return { stdout: "abc123def456\n", stderr: "" };
        case "ls-files --error-unmatch -- a.ts":
          return { stdout: "a.ts\n", stderr: "" };
        case "ls-files --error-unmatch -- b.ts":
          return { stdout: "b.ts\n", stderr: "" };
        default:
          throw new Error(`Unexpected git call: ${key}`);
      }
    };
    const repoContextCache = new Map();

    await resolveGitHubBlobUrlForLocalPath("/repo/a.ts:1", { execFile, repoContextCache });
    await resolveGitHubBlobUrlForLocalPath("/repo/b.ts:2", { execFile, repoContextCache });

    expect(remoteCallCount).toBe(1);
  });

  it("returns null for untracked files inside the repo", async () => {
    const execFile = async (_file: string, args: ReadonlyArray<string>) => {
      const key = args.slice(2).join(" ");
      switch (key) {
        case "rev-parse --show-toplevel":
          return { stdout: "/repo\n", stderr: "" };
        case "remote get-url origin":
          return { stdout: "git@github.com:pingdotgg/t3code.git\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "abc123def456\n", stderr: "" };
        case "symbolic-ref --quiet --short HEAD":
          return { stdout: "main\n", stderr: "" };
        case "rev-parse --verify --quiet refs/remotes/origin/main":
          return { stdout: "abc123def456\n", stderr: "" };
        case "ls-files --error-unmatch -- tmp/generated-report.html":
          throw new Error("not tracked");
        default:
          throw new Error(`Unexpected git call: ${key}`);
      }
    };

    await expect(
      resolveGitHubBlobUrlForLocalPath("/repo/tmp/generated-report.html:1", { execFile }),
    ).resolves.toBe(null);
  });
});

describe("resolveGitHubBlobUrlForPathReference", () => {
  it("resolves repo-relative line ranges against the provided cwd", async () => {
    const execFile = async (_file: string, args: ReadonlyArray<string>) => {
      const key = args.slice(2).join(" ");
      switch (key) {
        case "rev-parse --show-toplevel":
          return { stdout: "/repo\n", stderr: "" };
        case "remote get-url origin":
          return { stdout: "git@github.com:pingdotgg/t3code.git\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "deadbeefcafebabe\n", stderr: "" };
        case "symbolic-ref --quiet --short HEAD":
          return { stdout: "main\n", stderr: "" };
        case "rev-parse --verify --quiet refs/remotes/origin/main":
          return { stdout: "deadbeefcafebabe\n", stderr: "" };
        case "ls-files --error-unmatch -- api/src/EasyLife/Standard/RealPacking.Controllers.ts":
          return {
            stdout: "api/src/EasyLife/Standard/RealPacking.Controllers.ts\n",
            stderr: "",
          };
        default:
          throw new Error(`Unexpected git call: ${key}`);
      }
    };

    await expect(
      resolveGitHubBlobUrlForPathReference(
        "api/src/EasyLife/Standard/RealPacking.Controllers.ts:186-212",
        {
          cwd: "/repo",
          execFile,
        },
      ),
    ).resolves.toBe(
      "https://github.com/pingdotgg/t3code/blob/main/api/src/EasyLife/Standard/RealPacking.Controllers.ts#L186",
    );
  });
});

describe("GitHub link resolution cache", () => {
  it("reuses git results across independent and concurrent resolutions", async () => {
    const calls = new Map<string, number>();
    const execFile = async (_file: string, args: ReadonlyArray<string>) => {
      const key = args.slice(2).join(" ");
      calls.set(key, (calls.get(key) ?? 0) + 1);
      switch (key) {
        case "rev-parse --show-toplevel":
          return { stdout: "/repo\n", stderr: "" };
        case "remote get-url origin":
          return { stdout: "git@github.com:pingdotgg/t3code.git\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "deadbeefcafebabe\n", stderr: "" };
        case "symbolic-ref --quiet --short HEAD":
          return { stdout: "main\n", stderr: "" };
        case "rev-parse --verify --quiet refs/remotes/origin/main":
          return { stdout: "deadbeefcafebabe\n", stderr: "" };
        case "ls-files --error-unmatch -- apps/server/src/index.ts":
          return { stdout: "apps/server/src/index.ts\n", stderr: "" };
        default:
          throw new Error(`Unexpected git call: ${key}`);
      }
    };
    const cache = createGitHubLinkResolutionCache();
    const options = { cache, execFile };

    const [first, second] = await Promise.all([
      resolveGitHubBlobUrlForLocalPath("/repo/apps/server/src/index.ts:10", options),
      resolveGitHubBlobUrlForLocalPath("/repo/apps/server/src/index.ts:20", options),
    ]);
    const third = await resolveGitHubBlobUrlForLocalPath(
      "/repo/apps/server/src/index.ts:30",
      options,
    );
    const workspaceUrl = await resolveGitHubUrlForWorkspace("/repo", options);

    expect(first).toContain("#L10");
    expect(second).toContain("#L20");
    expect(third).toContain("#L30");
    expect(workspaceUrl).toBe("https://github.com/pingdotgg/t3code");
    expect([...calls.values()].every((count) => count === 1)).toBe(true);
  });

  it("refreshes tracked state after its short TTL", async () => {
    let now = 0;
    let tracked = true;
    let trackedCalls = 0;
    const execFile = async (_file: string, args: ReadonlyArray<string>) => {
      const key = args.slice(2).join(" ");
      switch (key) {
        case "rev-parse --show-toplevel":
          return { stdout: "/repo\n", stderr: "" };
        case "remote get-url origin":
          return { stdout: "git@github.com:pingdotgg/t3code.git\n", stderr: "" };
        case "rev-parse HEAD":
          return { stdout: "deadbeefcafebabe\n", stderr: "" };
        case "symbolic-ref --quiet --short HEAD":
          return { stdout: "main\n", stderr: "" };
        case "rev-parse --verify --quiet refs/remotes/origin/main":
          return { stdout: "deadbeefcafebabe\n", stderr: "" };
        case "ls-files --error-unmatch -- generated/report.html":
          trackedCalls += 1;
          if (!tracked) throw new Error("not tracked");
          return { stdout: "generated/report.html\n", stderr: "" };
        default:
          throw new Error(`Unexpected git call: ${key}`);
      }
    };
    const cache = createGitHubLinkResolutionCache({ now: () => now, trackedPathTtlMs: 10 });
    const options = { cache, execFile };

    await expect(
      resolveGitHubBlobUrlForLocalPath("/repo/generated/report.html", options),
    ).resolves.toContain("/generated/report.html");
    tracked = false;
    await expect(
      resolveGitHubBlobUrlForLocalPath("/repo/generated/report.html", options),
    ).resolves.toContain("/generated/report.html");

    now = 11;
    await expect(
      resolveGitHubBlobUrlForLocalPath("/repo/generated/report.html", options),
    ).resolves.toBeNull();
    expect(trackedCalls).toBe(2);
  });
});
