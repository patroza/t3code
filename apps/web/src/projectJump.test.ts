import { describe, expect, it } from "vite-plus/test";

import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { parseProjectJumpAction, resolveProjectJumpTarget } from "./projectJump";

const environmentId = EnvironmentId.make("local");
const project = {
  id: ProjectId.make("scanner-project"),
  environmentId,
  title: "Scanner",
  workspaceRoot: "/work/scanner",
  repositoryIdentity: {
    canonicalKey: "github.com/macs-holding/scanner",
    locator: { source: "git-remote", remoteName: "origin", remoteUrl: "git@example/scanner.git" },
    owner: "macs-holding",
    name: "scanner",
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
} as EnvironmentProject;

describe("project jumps", () => {
  it("matches short names and owner/repository names", () => {
    expect(resolveProjectJumpTarget("scanner", [project], [])?.project).toBe(project);
    expect(resolveProjectJumpTarget("macs-holding/scanner", [project], [])?.project).toBe(project);
  });

  it("prefers the environment with the latest thread activity", () => {
    const newerProject = {
      ...project,
      id: ProjectId.make("scanner-project-remote"),
      environmentId: EnvironmentId.make("remote"),
    };
    const threads = [
      {
        id: ThreadId.make("latest"),
        projectId: newerProject.id,
        environmentId: newerProject.environmentId,
        archivedAt: null,
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
    ] as EnvironmentThreadShell[];

    expect(resolveProjectJumpTarget("scanner", [project, newerProject], threads)?.project).toBe(
      newerProject,
    );
  });

  it("defaults unknown actions to reveal", () => {
    expect(parseProjectJumpAction(undefined)).toBe("reveal");
    expect(parseProjectJumpAction("latest")).toBe("latest");
    expect(parseProjectJumpAction("new")).toBe("new");
  });
});
