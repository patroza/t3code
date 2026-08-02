import { describe, expect, it } from "vite-plus/test";
import {
  prMergedProjectScript,
  projectScriptCwd,
  projectScriptRuntimeEnv,
  setupProjectScript,
  worktreeRemoveProjectScript,
} from "@t3tools/shared/projectScripts";

import {
  buildProjectScript,
  clearConflictingLifecycleFlags,
  commandForProjectScript,
  nextProjectScriptId,
  primaryProjectScript,
  projectScriptIdFromCommand,
  projectScriptMenuLabel,
} from "./projectScripts";

describe("projectScripts helpers", () => {
  it("builds scripts with preview settings", () => {
    expect(
      buildProjectScript("dev", {
        name: "Dev server",
        command: "pnpm dev",
        icon: "debug",
        runOnWorktreeCreate: false,
        runOnWorktreeRemove: false,
        runOnPrMerged: false,
        previewUrl: "http://localhost:5733",
        autoOpenPreview: true,
      }),
    ).toEqual({
      id: "dev",
      name: "Dev server",
      command: "pnpm dev",
      icon: "debug",
      runOnWorktreeCreate: false,
      previewUrl: "http://localhost:5733",
      autoOpenPreview: true,
    });
  });

  it("omits preview settings when no preview URL is configured", () => {
    expect(
      buildProjectScript("test", {
        name: "Test",
        command: "pnpm test",
        icon: "test",
        runOnWorktreeCreate: false,
        runOnWorktreeRemove: false,
        runOnPrMerged: false,
        previewUrl: null,
        autoOpenPreview: false,
      }),
    ).toEqual({
      id: "test",
      name: "Test",
      command: "pnpm test",
      icon: "test",
      runOnWorktreeCreate: false,
    });
  });

  it("includes lifecycle flags only when enabled", () => {
    expect(
      buildProjectScript("teardown", {
        name: "Teardown",
        command: "pkill -f something || true",
        icon: "configure",
        runOnWorktreeCreate: false,
        runOnWorktreeRemove: true,
        runOnPrMerged: true,
        previewUrl: null,
        autoOpenPreview: false,
      }),
    ).toEqual({
      id: "teardown",
      name: "Teardown",
      command: "pkill -f something || true",
      icon: "configure",
      runOnWorktreeCreate: false,
      runOnWorktreeRemove: true,
      runOnPrMerged: true,
    });
  });

  it("builds and parses script run commands", () => {
    const command = commandForProjectScript("lint");
    expect(command).toBe("script.lint.run");
    expect(projectScriptIdFromCommand(command)).toBe("lint");
    expect(projectScriptIdFromCommand("terminal.toggle")).toBeNull();
  });

  it("slugifies and dedupes project script ids", () => {
    expect(nextProjectScriptId("Run Tests", [])).toBe("run-tests");
    expect(nextProjectScriptId("Run Tests", ["run-tests"])).toBe("run-tests-2");
    expect(nextProjectScriptId("!!!", [])).toBe("script");
  });

  it("resolves primary and lifecycle scripts", () => {
    const scripts = [
      {
        id: "setup",
        name: "Setup",
        command: "bun install",
        icon: "configure" as const,
        runOnWorktreeCreate: true,
      },
      {
        id: "teardown",
        name: "Teardown",
        command: "echo cleanup",
        icon: "configure" as const,
        runOnWorktreeCreate: false,
        runOnWorktreeRemove: true,
      },
      {
        id: "merged",
        name: "On merge",
        command: "echo merged",
        icon: "configure" as const,
        runOnWorktreeCreate: false,
        runOnPrMerged: true,
      },
      {
        id: "test",
        name: "Test",
        command: "bun test",
        icon: "test" as const,
        runOnWorktreeCreate: false,
      },
    ];

    expect(primaryProjectScript(scripts)?.id).toBe("test");
    expect(setupProjectScript(scripts)?.id).toBe("setup");
    expect(worktreeRemoveProjectScript(scripts)?.id).toBe("teardown");
    expect(prMergedProjectScript(scripts)?.id).toBe("merged");
    expect(projectScriptMenuLabel(scripts[1]!)).toBe("Teardown (teardown)");
  });

  it("clears conflicting lifecycle flags from other scripts", () => {
    const existing = {
      id: "old-teardown",
      name: "Old teardown",
      command: "echo old",
      icon: "configure" as const,
      runOnWorktreeCreate: false,
      runOnWorktreeRemove: true,
      runOnPrMerged: true,
    };
    const cleared = clearConflictingLifecycleFlags(existing, {
      runOnWorktreeCreate: false,
      runOnWorktreeRemove: true,
      runOnPrMerged: false,
    });
    expect(cleared.runOnWorktreeRemove).toBeUndefined();
    expect(cleared.runOnPrMerged).toBe(true);
  });

  it("builds default runtime env for scripts", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      worktreePath: "/repo/worktree-a",
    });

    expect(env).toMatchObject({
      T3CODE_PROJECT_ROOT: "/repo",
      T3CODE_WORKTREE_PATH: "/repo/worktree-a",
    });
  });

  it("allows overriding runtime env values", () => {
    const env = projectScriptRuntimeEnv({
      project: { cwd: "/repo" },
      extraEnv: {
        T3CODE_PROJECT_ROOT: "/custom-root",
        CUSTOM_FLAG: "1",
      },
    });

    expect(env.T3CODE_PROJECT_ROOT).toBe("/custom-root");
    expect(env.CUSTOM_FLAG).toBe("1");
    expect(env.T3CODE_WORKTREE_PATH).toBeUndefined();
  });

  it("prefers the worktree path for script cwd resolution", () => {
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: "/repo/worktree-a",
      }),
    ).toBe("/repo/worktree-a");
    expect(
      projectScriptCwd({
        project: { cwd: "/repo" },
        worktreePath: null,
      }),
    ).toBe("/repo");
  });
});
