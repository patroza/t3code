import { assert, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { VcsRepositoryDetectionError } from "@t3tools/contracts";

import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ProjectLifecycleScriptRunner from "../project/ProjectLifecycleScriptRunner.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriver from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

const lifecycleScriptRunnerMock = Layer.mock(
  ProjectLifecycleScriptRunner.ProjectLifecycleScriptRunner,
)({
  runWorktreeRemove: () => Effect.succeed({ status: "no-script" as const }),
  runPrMerged: () => Effect.succeed({ status: "no-script" as const }),
});

function makeLayer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
  readonly resolve?: VcsDriverRegistry.VcsDriverRegistry["Service"]["resolve"];
  readonly driver?: Record<string, unknown>;
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
        ...(input.resolve ? { resolve: input.resolve } : {}),
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(input.driver ?? {})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
    Layer.provide(lifecycleScriptRunnerMock),
  );
}

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

/**
 * A repository with no checkout of its own — the shape a bare worktree source
 * repo (or a repo whose `core.bare` says so) detects as.
 */
function bareHandle(cwd: string): VcsDriverRegistry.VcsDriverHandle {
  return {
    kind: "git",
    repository: {
      kind: "git",
      rootPath: `${cwd}/.git`,
      metadataPath: `${cwd}/.git`,
      bare: true,
      freshness: {
        source: "live-local",
        observedAt: TEST_EPOCH,
        expiresAt: Option.none(),
      },
    },
    driver: {} as unknown as VcsDriver.VcsDriver["Service"],
  };
}

describe("GitWorkflowService", () => {
  it.effect("returns an empty local status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.localStatus({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("returns an empty full status when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const status = yield* workflow.status({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(status, {
        isRepo: false,
        hasPrimaryRemote: false,
        isDefaultRef: false,
        refName: null,
        hasWorkingTreeChanges: false,
        workingTree: {
          files: [],
          insertions: 0,
          deletions: 0,
        },
        hasUpstream: false,
        aheadCount: 0,
        behindCount: 0,
        aheadOfDefaultCount: 0,
        pr: null,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("does not call GitManager status methods when no VCS repository is detected", () => {
    const localStatus = vi.fn();
    const remoteStatus = vi.fn();
    const status = vi.fn();

    const testLayer = GitWorkflowService.layer.pipe(
      Layer.provide(
        Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
          detect: () => Effect.succeed(null),
        }),
      ),
      Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
      Layer.provide(
        Layer.mock(GitManager.GitManager)({
          localStatus,
          remoteStatus,
          status,
        }),
      ),
      Layer.provide(lifecycleScriptRunnerMock),
    );

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      yield* workflow.localStatus({ cwd: "/not-a-repo" });
      yield* workflow.remoteStatus({ cwd: "/not-a-repo" });
      yield* workflow.status({ cwd: "/not-a-repo" });

      assert.equal(localStatus.mock.calls.length, 0);
      assert.equal(remoteStatus.mock.calls.length, 0);
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(testLayer));
  });

  it.effect("returns an empty ref list when no VCS repository is detected", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const refs = yield* workflow.listRefs({ cwd: "/not-a-repo" });

      assert.deepStrictEqual(refs, {
        refs: [],
        isRepo: false,
        hasPrimaryRemote: false,
        nextCursor: null,
        totalCount: 0,
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.succeed(null),
        }),
      ),
    ),
  );

  it.effect("structures workflow detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.status({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitManagerError",
        operation: "GitWorkflowService.status",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git workflow.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  it.effect("structures command detection failures without exposing upstream details", () => {
    const cause = new VcsRepositoryDetectionError({
      operation: "VcsDriverRegistry.detect",
      cwd: "/repo",
      detail: "upstream command detail must stay in the cause chain",
    });

    return Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const error = yield* workflow.listRefs({ cwd: "/repo" }).pipe(Effect.flip);

      expect(error).toMatchObject({
        _tag: "GitCommandError",
        operation: "GitWorkflowService.listRefs",
        command: "vcs-route",
        cwd: "/repo",
        detail: "Failed to detect a VCS repository for this Git command.",
      });
      expect(error.message).not.toContain(cause.detail);
    }).pipe(
      Effect.provide(
        makeLayer({
          detect: () => Effect.fail(cause),
        }),
      ),
    );
  });

  describe("bare repositories", () => {
    it.effect("creates a worktree from a bare repository", () => {
      // The service builds driver effects eagerly, so execution has to be
      // recorded from inside the effect rather than from a call count.
      let ran = false;
      const createWorktree = () =>
        Effect.sync(() => {
          ran = true;
          return { worktree: { path: "/worktrees/feature", refName: "feature" } };
        });

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const result = yield* workflow.createWorktree({
          cwd: "/bare-repo",
          refName: "main",
          newRefName: "feature",
        });

        assert.deepStrictEqual(result.worktree, {
          path: "/worktrees/feature",
          refName: "feature",
        });
        assert.isTrue(ran);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.succeed(bareHandle("/bare-repo")),
            resolve: () => Effect.succeed(bareHandle("/bare-repo")),
            driver: { createWorktree },
          }),
        ),
      );
    });

    it.effect("fetches into a bare repository", () => {
      let ran = false;
      const fetchRemote = () =>
        Effect.sync(() => {
          ran = true;
        });

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.fetchRemote({ cwd: "/bare-repo", remoteName: "origin" });

        assert.isTrue(ran);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.succeed(bareHandle("/bare-repo")),
            resolve: () => Effect.succeed(bareHandle("/bare-repo")),
            driver: { fetchRemote },
          }),
        ),
      );
    });

    it.effect("rejects a checkout-dependent command with an actionable reason", () => {
      let ran = false;
      const switchRef = () =>
        Effect.sync(() => {
          ran = true;
          return { refName: "main" };
        });

      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const error = yield* workflow
          .switchRef({ cwd: "/bare-repo", refName: "main" })
          .pipe(Effect.flip);

        expect(error).toMatchObject({
          _tag: "GitCommandError",
          operation: "GitWorkflowService.switchRef",
          command: "vcs-route",
          cwd: "/bare-repo",
        });
        expect(error.detail).toContain("needs a working tree");
        expect(error.detail).toContain("bare Git repository");
        // The gate must short-circuit before the driver command runs.
        assert.isFalse(ran);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.succeed(bareHandle("/bare-repo")),
            resolve: () => Effect.succeed(bareHandle("/bare-repo")),
            driver: { switchRef },
          }),
        ),
      );
    });

    it.effect("reports a bare repository as having no working tree status", () =>
      Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const status = yield* workflow.localStatus({ cwd: "/bare-repo" });

        assert.equal(status.isRepo, false);
        assert.equal(status.hasWorkingTreeChanges, false);
      }).pipe(
        Effect.provide(
          makeLayer({
            detect: () => Effect.succeed(bareHandle("/bare-repo")),
            resolve: () => Effect.succeed(bareHandle("/bare-repo")),
          }),
        ),
      ),
    );
  });
});
