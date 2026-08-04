import { describe, expect, it } from "vite-plus/test";

import { resolveWorktreeBaseBranch } from "./gitDefaultBranch.ts";

describe("resolveWorktreeBaseBranch", () => {
  it("uses origin/HEAD when the repository default is not main", async () => {
    const branch = await resolveWorktreeBaseBranch({
      workspaceRoot: "/repo",
      execFile: async (_file, args) => {
        expect(args).toContain("refs/remotes/origin/HEAD");
        return { stdout: "refs/remotes/origin/fork/changes\n" };
      },
    });
    expect(branch).toBe("fork/changes");
  });

  it("uses HEAD for a bare repository without origin/HEAD", async () => {
    const branch = await resolveWorktreeBaseBranch({
      workspaceRoot: "/repo.git",
      execFile: async (_file, args) => {
        const command = args.slice(2).join(" ");
        if (command === "symbolic-ref refs/remotes/origin/HEAD") throw new Error("missing");
        if (command === "rev-parse --is-bare-repository") return { stdout: "true\n" };
        if (command === "symbolic-ref HEAD") return { stdout: "refs/heads/fork/changes\n" };
        throw new Error(`unexpected command: ${command}`);
      },
    });
    expect(branch).toBe("fork/changes");
  });

  it("keeps an explicit configured or mention override", async () => {
    await expect(
      resolveWorktreeBaseBranch({
        workspaceRoot: "/repo",
        override: "release",
        execFile: async () => {
          throw new Error("unused");
        },
      }),
    ).resolves.toBe("release");
  });
});
