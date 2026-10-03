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

  it("matches a repository the project only carries as a secondary remote", () => {
    const withSubtreeRemote = {
      ...project,
      repositoryIdentity: {
        ...project.repositoryIdentity,
        remotes: [
          {
            remoteName: "effect-app-libs",
            remoteUrl: "https://github.com/effect-app/libs.git",
            canonicalKey: "github.com/effect-app/libs",
            owner: "effect-app",
            name: "libs",
          },
        ],
      },
    } as EnvironmentProject;

    expect(resolveProjectJumpTarget("libs", [withSubtreeRemote], [])?.project).toBe(
      withSubtreeRemote,
    );
  });

  it("prefers the project itself over a busier clone that only lists it as a remote", () => {
    const scannerWithLibsRemote = {
      ...project,
      id: ProjectId.make("scanner-with-libs-remote"),
      environmentId: EnvironmentId.make("remote"),
      repositoryIdentity: {
        ...project.repositoryIdentity,
        remotes: [
          {
            remoteName: "effect-app-libs",
            remoteUrl: "https://github.com/effect-app/libs.git",
            canonicalKey: "github.com/effect-app/libs",
            owner: "effect-app",
            name: "libs",
          },
        ],
      },
    } as EnvironmentProject;
    const libs = {
      ...project,
      id: ProjectId.make("libs-project"),
      title: "libs",
      workspaceRoot: "/work/effect-app/libs",
      repositoryIdentity: {
        canonicalKey: "github.com/effect-app/libs",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "git@example/libs.git",
        },
        owner: "effect-app",
        name: "libs",
      },
    } as EnvironmentProject;
    const threads = [
      {
        id: ThreadId.make("busy"),
        projectId: scannerWithLibsRemote.id,
        environmentId: scannerWithLibsRemote.environmentId,
        archivedAt: null,
        updatedAt: "2026-04-01T00:00:00.000Z",
      },
      {
        id: ThreadId.make("stale"),
        projectId: libs.id,
        environmentId: libs.environmentId,
        archivedAt: null,
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ] as EnvironmentThreadShell[];

    const target = resolveProjectJumpTarget("libs", [scannerWithLibsRemote, libs], threads);
    expect(target?.project).toBe(libs);
    expect(target?.latestThread?.id).toBe("stale");
  });

  it("defaults unknown actions to reveal", () => {
    expect(parseProjectJumpAction(undefined)).toBe("reveal");
    expect(parseProjectJumpAction("latest")).toBe("latest");
    expect(parseProjectJumpAction("new")).toBe("new");
  });
});
