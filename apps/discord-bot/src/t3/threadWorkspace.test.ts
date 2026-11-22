// @effect-diagnostics nodeBuiltinImport:off globalErrorInEffectFailure:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  T3_PROJECT_FILE_NAME,
  type OrchestrationProjectShell,
  type ServerSettings,
  type VcsListRefsResult,
  type VcsRef,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { T3Session, T3SessionError, type T3SessionService } from "./T3Session.ts";
import {
  launchWorkspaceFields,
  resolveLaunchWorkspace,
  worktreeBaseBranchFromRefs,
} from "./threadWorkspace.ts";

const projectId = ProjectId.make("project-1");

function project(
  workspaceRoot = "/workspace/repo",
  defaultThreadEnvMode?: "local" | "worktree",
): OrchestrationProjectShell {
  return {
    id: projectId,
    workspaceRoot,
    ...(defaultThreadEnvMode === undefined ? {} : { defaultThreadEnvMode }),
  } as OrchestrationProjectShell;
}

function branchList(
  items: ReadonlyArray<Pick<VcsRef, "name" | "isDefault" | "current">>,
  isRepo = true,
): VcsListRefsResult {
  return {
    refs: items.map((item) => ({
      name: item.name,
      isDefault: item.isDefault,
      current: item.current,
      isRemote: item.name.includes("/"),
      worktreePath: null,
    })),
    isRepo,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: items.length,
  };
}

function mockSession(input: {
  readonly settings?: ServerSettings;
  readonly newProjectsRoot?: string | null;
  readonly unavailable?: boolean;
  readonly threads?: ReadonlyArray<{
    readonly projectId: ProjectId;
    readonly deletedAt: string | null;
  }>;
  readonly refs?: VcsListRefsResult;
  readonly listRefsCalls?: { count: number };
}): T3SessionService {
  return {
    serverConfig: () =>
      Effect.succeed(
        input.unavailable === true
          ? null
          : {
              settings: input.settings ?? DEFAULT_SERVER_SETTINGS,
              newProjectsRoot: input.newProjectsRoot ?? "/projects",
            },
      ),
    shell: () => Effect.succeed({ threads: input.threads ?? [] }),
    listRefs: () => {
      if (input.listRefsCalls !== undefined) input.listRefsCalls.count += 1;
      return input.refs === undefined
        ? Effect.fail(new T3SessionError("listRefs was not expected"))
        : Effect.succeed(input.refs);
    },
  } as unknown as T3SessionService;
}

function folded(
  override: ServerSettings["projectSettingsOverrides"][ProjectId],
  settings: ServerSettings = DEFAULT_SERVER_SETTINGS,
): ServerSettings {
  return {
    ...settings,
    projectSettingsFolded: true,
    projectSettingsOverrides: {
      ...settings.projectSettingsOverrides,
      [projectId]: override,
    },
  };
}

const resolve = (
  session: T3SessionService,
  input: {
    readonly project?: OrchestrationProjectShell;
    readonly explicitLocal?: boolean;
    readonly explicitBase?: string;
  } = {},
) =>
  resolveLaunchWorkspace({
    project: input.project ?? project(),
    explicitLocal: input.explicitLocal === true,
    ...(input.explicitBase === undefined ? {} : { explicitBase: input.explicitBase }),
  }).pipe(Effect.provideService(T3Session, session));

describe("worktreeBaseBranchFromRefs", () => {
  it("prefers the default ref over the current branch and ignores main", () => {
    expect(
      worktreeBaseBranchFromRefs([
        { name: "main", isDefault: false, current: false },
        { name: "feature", isDefault: false, current: true },
        { name: "fork/dev", isDefault: true, current: false },
      ]),
    ).toBe("fork/dev");
  });

  it("uses the current branch when the repository has no default", () => {
    expect(
      worktreeBaseBranchFromRefs([
        { name: "main", isDefault: false, current: false },
        { name: "topic", isDefault: false, current: true },
      ]),
    ).toBe("topic");
  });

  it("returns null when neither a default nor a current branch exists", () => {
    expect(worktreeBaseBranchFromRefs([{ name: "main", isDefault: false, current: false }])).toBe(
      null,
    );
  });
});

describe("launchWorkspaceFields", () => {
  it("omits the base branch for a main checkout", () => {
    expect(
      launchWorkspaceFields({ local: true, baseBranch: null, startFromOrigin: false }),
    ).toEqual({
      local: true,
      startFromOrigin: false,
    });
  });
});

describe("resolveLaunchWorkspace", () => {
  effectIt.effect("uses the project worktree setting and the repository default branch", () =>
    Effect.gen(function* () {
      const listRefsCalls = { count: 0 };
      const workspace = yield* resolve(
        mockSession({
          settings: folded({ defaultThreadEnvMode: "worktree" }),
          refs: branchList([
            { name: "main", isDefault: false, current: true },
            { name: "fork/dev", isDefault: true, current: false },
          ]),
          listRefsCalls,
        }),
      );
      expect(workspace).toEqual({
        local: false,
        baseBranch: "fork/dev",
        startFromOrigin: true,
      });
      expect(listRefsCalls.count).toBe(1);
    }),
  );

  effectIt.effect("stays on the main checkout when every tier is unset", () =>
    Effect.gen(function* () {
      const listRefsCalls = { count: 0 };
      const workspace = yield* resolve(mockSession({ listRefsCalls }));
      expect(workspace).toEqual({ local: true, baseBranch: null, startFromOrigin: false });
      expect(listRefsCalls.count).toBe(0);
    }),
  );

  effectIt.effect("follows an environment worktree default outside the new-projects folder", () =>
    Effect.gen(function* () {
      const workspace = yield* resolve(
        mockSession({
          settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
          refs: branchList([{ name: "origin/fork/dev", isDefault: true, current: false }]),
        }),
      );
      expect(workspace).toEqual({
        local: false,
        baseBranch: "origin/fork/dev",
        startFromOrigin: true,
      });
    }),
  );

  effectIt.effect("reads t3.json when the environment workspace setting is inherited", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workspace-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(
          NodePath.join(directory, T3_PROJECT_FILE_NAME),
          JSON.stringify({ defaultThreadEnvMode: "worktree" }),
        ),
      );
      const workspace = yield* resolve(
        mockSession({
          refs: branchList([{ name: "fork/dev", isDefault: true, current: false }]),
        }),
        { project: project(directory) },
      );
      expect(workspace.local).toBe(false);
      expect(workspace.baseBranch).toBe("fork/dev");
    }).pipe(Effect.scoped),
  );

  effectIt.effect("ignores an unreadable t3.json and keeps the built-in checkout", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-workspace-"))),
        (path) => Effect.promise(() => NodeFSP.rm(path, { recursive: true, force: true })),
      );
      yield* Effect.promise(() =>
        NodeFSP.writeFile(NodePath.join(directory, T3_PROJECT_FILE_NAME), "{"),
      );
      const workspace = yield* resolve(mockSession({}), { project: project(directory) });
      expect(workspace.local).toBe(true);
    }).pipe(Effect.scoped),
  );

  effectIt.effect("lets --local win over a worktree setting and over --base", () =>
    Effect.gen(function* () {
      const listRefsCalls = { count: 0 };
      const workspace = yield* resolve(
        mockSession({
          settings: folded({ defaultThreadEnvMode: "worktree" }),
          listRefsCalls,
        }),
        { explicitLocal: true, explicitBase: "develop" },
      );
      expect(workspace).toEqual({ local: true, baseBranch: null, startFromOrigin: false });
      expect(listRefsCalls.count).toBe(0);
    }),
  );

  effectIt.effect("lets --base force a worktree of that branch when the setting is local", () =>
    Effect.gen(function* () {
      const listRefsCalls = { count: 0 };
      const workspace = yield* resolve(mockSession({ listRefsCalls }), {
        explicitBase: "develop",
      });
      expect(workspace).toEqual({
        local: false,
        baseBranch: "develop",
        startFromOrigin: true,
      });
      expect(listRefsCalls.count).toBe(0);
    }),
  );

  effectIt.effect("treats a blank base as unset", () =>
    Effect.gen(function* () {
      const workspace = yield* resolve(mockSession({}), { explicitBase: "  " });
      expect(workspace.local).toBe(true);
    }),
  );

  effectIt.effect("falls back to the current branch when no ref is the default", () =>
    Effect.gen(function* () {
      const workspace = yield* resolve(
        mockSession({
          settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
          refs: branchList([
            { name: "main", isDefault: false, current: false },
            { name: "topic", isDefault: false, current: true },
          ]),
        }),
      );
      expect(workspace.baseBranch).toBe("topic");
    }),
  );

  effectIt.effect("fails instead of guessing main when the repository has no branch", () =>
    Effect.gen(function* () {
      const missing = yield* Effect.flip(
        resolve(
          mockSession({
            settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
            refs: branchList([{ name: "main", isDefault: false, current: false }]),
          }),
        ),
      );
      expect(missing.message).toContain("no default branch");
      const notARepo = yield* Effect.flip(
        resolve(
          mockSession({
            settings: { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
            refs: branchList([], false),
          }),
        ),
      );
      expect(notARepo.message).toContain("no default branch");
    }),
  );

  effectIt.effect("passes a project Start from remote override through", () =>
    Effect.gen(function* () {
      const workspace = yield* resolve(
        mockSession({
          settings: folded(
            { newWorktreesStartFromOrigin: false },
            { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" },
          ),
          refs: branchList([{ name: "fork/dev", isDefault: true, current: false }]),
        }),
      );
      expect(workspace).toEqual({
        local: false,
        baseBranch: "fork/dev",
        startFromOrigin: false,
      });
    }),
  );

  effectIt.effect("keeps a brand-new project folder on its checkout until it has a thread", () =>
    Effect.gen(function* () {
      const fresh = project("/projects/fresh");
      const settings = { ...DEFAULT_SERVER_SETTINGS, defaultThreadEnvMode: "worktree" as const };
      const before = yield* resolve(
        mockSession({
          settings,
          newProjectsRoot: "/projects",
          refs: branchList([{ name: "fork/dev", isDefault: true, current: false }]),
        }),
        { project: fresh },
      );
      expect(before.local).toBe(true);

      const deleted = yield* resolve(
        mockSession({
          settings,
          newProjectsRoot: "/projects",
          threads: [{ projectId, deletedAt: "2026-01-01T00:00:00.000Z" }],
          refs: branchList([{ name: "fork/dev", isDefault: true, current: false }]),
        }),
        { project: fresh },
      );
      expect(deleted.local).toBe(true);

      const after = yield* resolve(
        mockSession({
          settings,
          newProjectsRoot: "/projects",
          threads: [{ projectId, deletedAt: null }],
          refs: branchList([{ name: "fork/dev", isDefault: true, current: false }]),
        }),
        { project: fresh },
      );
      expect(after).toEqual({
        local: false,
        baseBranch: "fork/dev",
        startFromOrigin: true,
      });
    }),
  );

  effectIt.effect("fails when T3 settings are not loaded", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(resolve(mockSession({ unavailable: true })));
      expect(error.message).toContain("T3 settings are not loaded yet");
    }),
  );
});
