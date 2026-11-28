import {
  EnvironmentId,
  IdentityUsername,
  PersonId,
  ProjectId,
  ProviderInstanceId,
  SourceControlProviderKind,
  ThreadId,
  type OrchestrationProjectShell,
  type PullRequestActionInput,
  type PullRequestSubmitReviewInput,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as GitHubAppInstallationAuth from "@t3tools/source-control-github/server/appInstallationAuth";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { type Tool } from "effect/ai";

import * as GitManager from "../git/GitManager.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as PullRequestsHandlers from "../mcp/toolkits/pullRequests/handlers.ts";
import { PullRequestsToolkit } from "../mcp/toolkits/pullRequests/tools.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import {
  type PullRequestTestThread,
  v2PullRequestThread,
} from "../orchestration-v2/testkit/pullRequestFixtures.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as PullRequestWatchService from "../pullRequest/PullRequestWatchService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { withGitHubAgentRead, withGitHubAgentWrite } from "./GitHubAgentPrRouting.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(7));

const APP_DECISION: GitHubAppInstallationAuth.GitHubAppRoutingDecision = {
  mode: "app",
  host: "github.com",
  token: Redacted.make("app-token-xyz"),
  fingerprint: "fp-app",
  appId: "4331997",
  appSlug: "omegent-app",
  actor: "omegent-app[bot]",
  installationId: 101,
};

function makeFakeAuthService(input: {
  readonly config?: GitHubAppInstallationAuth.GitHubAppAgentAuthConfig;
  readonly resolve: GitHubAppInstallationAuth.GitHubAppInstallationAuth["Service"]["resolve"];
}) {
  return Layer.succeed(GitHubAppInstallationAuth.GitHubAppInstallationAuth, {
    config: input.config ?? { mode: "disabled" },
    resolve: input.resolve,
    invalidate: () => Effect.void,
  });
}

function makeProject(): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Shop",
    workspaceRoot: "/workspace/shop",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity: {
      canonicalKey: "github.com/macs-holding/shop",
      locator: {
        source: "git-remote",
        remoteName: "origin",
        remoteUrl: "git@github.com:macs-holding/shop.git",
      },
      provider: SourceControlProviderKind.make("github"),
      displayName: "macs-holding/shop",
      owner: "macs-holding",
      name: "shop",
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(pullRequests: ReadonlyArray<ThreadPullRequestLink>): PullRequestTestThread {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feat/shop",
    worktreePath: "/workspace/shop",
    pullRequests,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
  };
}

const invocationScope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: THREAD_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set<McpInvocationContext.McpCapability>(["pull-requests"]),
  issuedAt: 1,
};

const makeToolkitHarness = Effect.fn("makeGitHubAgentPrRoutingHarness")(function* (options: {
  readonly authLayer: Layer.Layer<GitHubAppInstallationAuth.GitHubAppInstallationAuth>;
  readonly pullRequests?: Partial<PullRequestService.PullRequestService["Service"]>;
  readonly git?: Partial<GitManager.GitManager["Service"]>;
}) {
  const project = makeProject();
  const thread = {
    ...v2PullRequestThread(
      makeThread([
        {
          host: "github.com",
          repository: "macs-holding/shop",
          number: 42,
          url: "https://github.com/macs-holding/shop/pull/42",
          source: "created",
          linkedAt: "2026-08-10T00:00:00.000Z",
          snapshot: {
            state: "open",
            title: "Shop PR",
            headBranch: "feat/shop",
            baseBranch: "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-08-27T00:00:00.000Z",
          },
          stack: null,
        },
      ]),
    ),
    originSource: {
      channel: "web" as const,
      personId: PersonId.make("patroza"),
      username: IdentityUsername.make("patroza"),
    },
  };

  const layerDependencies = Layer.mergeAll(
    options.authLayer,
    Layer.mock(PullRequestWatchService.PullRequestWatchService)({}),
    Layer.mock(ProjectService.ProjectService)({
      getShell: () => Effect.succeedSome(project),
      listShells: () => Effect.succeed([project]),
    }),
    Layer.mock(PullRequestReviewGuideService.PullRequestReviewGuideService)({}),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (id) => Effect.succeed(id === THREAD_ID ? thread : null),
      dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
    }),
    Layer.mock(PullRequestService.PullRequestService)({
      addressedProject: () => Effect.succeed(project),
      ...options.pullRequests,
    }),
    Layer.mock(GitManager.GitManager)(options.git ?? {}),
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
    ServerSettings.layerTest({}),
    McpToolAccessTestkit.liveThreadsLayer,
  );

  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(PullRequestsHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
  );

  const call = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PullRequestsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocationScope),
      Effect.provide(layerDependencies),
    );

  return { call };
});

describe("GitHubAgentPrRouting", () => {
  it.effect(
    "pins PinnedGitHubCredential and reports actor for App writes and personal writes",
    () =>
      Effect.gen(function* () {
        const appLayer = makeFakeAuthService({
          resolve: ({ repository }) =>
            repository.startsWith("macs-holding/")
              ? Effect.succeed(APP_DECISION)
              : Effect.succeed({ mode: "personal", configured: true }),
        });

        const registryLayer = Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders([
            {
              kind: SourceControlProviderKind.make("github"),
              getRoutingIdentity: () => Effect.succeed({ accountId: "1", viewer: "patroza" }),
            } as never,
          ]),
        );

        // App write pins credential and returns bot actor
        const appOutcome = yield* withGitHubAgentWrite(
          { host: "github.com", repository: "macs-holding/shop" },
          { mapAuthError: (e) => e.message },
          GitHubAppInstallationAuth.PinnedGitHubCredential,
        ).pipe(Effect.provide(Layer.mergeAll(appLayer, registryLayer)));
        expect(appOutcome.actor).toBe("omegent-app[bot]");
        expect(appOutcome.value?.source).toBe("app");
        expect(Redacted.value(appOutcome.value!.token)).toBe("app-token-xyz");

        // Personal write leaves credential unpinned and returns personal login
        const personalOutcome = yield* withGitHubAgentWrite(
          { host: "github.com", repository: "patroza/t3code" },
          { mapAuthError: (e) => e.message },
          GitHubAppInstallationAuth.PinnedGitHubCredential,
        ).pipe(Effect.provide(Layer.mergeAll(appLayer, registryLayer)));
        expect(personalOutcome.actor).toBe("patroza");
        expect(personalOutcome.value).toBeNull();

        // Read pins credential when App resolves
        const readPinned = yield* withGitHubAgentRead(
          { host: "github.com", repository: "macs-holding/shop" },
          GitHubAppInstallationAuth.PinnedGitHubCredential,
        ).pipe(Effect.provide(appLayer));
        expect(readPinned?.source).toBe("app");
      }),
  );

  it.effect(
    "allows approve, request-changes, and merge with the App credential even with legacy policy env and installed-or-personal routing",
    () =>
      Effect.gen(function* () {
        const files: Readonly<Record<string, string>> = {
          "/etc/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "/keys/omegent.pem",
                owners: ["macs-holding"],
              },
            ],
          }),
        };
        const legacyEnvKey = ["T3_GITHUB_APP", "AGENT", "POLICY"].join("_");
        const config = yield* GitHubAppInstallationAuth.loadGitHubAppAgentAuthConfig({
          env: {
            T3_GITHUB_APPS_FILE: "/etc/github-apps.json",
            T3_GITHUB_APP_ROUTING: "installed-or-personal",
            [legacyEnvKey]: "1",
          },
          fileSystem: FileSystem.makeNoop({
            exists: (path) => Effect.succeed(Object.prototype.hasOwnProperty.call(files, path)),
            readFileString: (path) => Effect.succeed(files[path]!),
          }),
        });
        expect(config.mode).toBe("apps-file");

        const submittedReviews: Array<{
          readonly input: PullRequestSubmitReviewInput;
          readonly pinnedToken: string | null;
        }> = [];
        const ranActions: Array<{
          readonly input: PullRequestActionInput;
          readonly pinnedToken: string | null;
        }> = [];

        const harness = yield* makeToolkitHarness({
          authLayer: makeFakeAuthService({
            config,
            resolve: () => Effect.succeed(APP_DECISION),
          }),
          pullRequests: {
            submitReview: (input) =>
              Effect.gen(function* () {
                const pinned = yield* GitHubAppInstallationAuth.PinnedGitHubCredential;
                submittedReviews.push({
                  input,
                  pinnedToken: pinned === null ? null : Redacted.value(pinned.token),
                });
              }),
            runAction: (input) =>
              Effect.gen(function* () {
                const pinned = yield* GitHubAppInstallationAuth.PinnedGitHubCredential;
                ranActions.push({
                  input,
                  pinnedToken: pinned === null ? null : Redacted.value(pinned.token),
                });
                return undefined;
              }),
            summary: () =>
              Effect.succeed({
                provider: SourceControlProviderKind.make("github"),
                projectId: PROJECT_ID,
                repository: "macs-holding/shop",
                number: 42,
                title: "Shop PR",
                url: "https://github.com/macs-holding/shop/pull/42",
                baseBranch: "main",
                headBranch: "feat/shop",
                state: "merged",
                isDraft: false,
                headSha: "deadbeef1234",
                updatedAt: "2026-08-27T00:00:00.000Z",
              }),
          },
        });

        const approveResult = yield* harness.call("pull_request_review", {
          number: 42,
          verdict: "approve",
          expectedHeadSha: "deadbeef1234",
          body: "LGTM",
        });
        expect(approveResult.actor).toBe("omegent-app[bot]");

        const changesResult = yield* harness.call("pull_request_review", {
          number: 42,
          verdict: "request-changes",
          body: "Needs a fix",
        });
        expect(changesResult.actor).toBe("omegent-app[bot]");

        const mergeResult = yield* harness.call("pull_request_merge", {
          number: 42,
          expectedHeadSha: "deadbeef1234",
          method: "squash",
        });
        expect(mergeResult.actor).toBe("omegent-app[bot]");
        expect(mergeResult.state).toBe("merged");

        expect(submittedReviews).toEqual([
          {
            input: expect.objectContaining({
              number: 42,
              verdict: "approve",
              expectedHeadSha: "deadbeef1234",
            }),
            pinnedToken: "app-token-xyz",
          },
          {
            input: expect.objectContaining({
              number: 42,
              verdict: "request-changes",
            }),
            pinnedToken: "app-token-xyz",
          },
        ]);
        expect(ranActions).toEqual([
          {
            input: expect.objectContaining({
              number: 42,
              action: "merge",
              expectedHeadSha: "deadbeef1234",
              mergeMethod: "squash",
            }),
            pinnedToken: "app-token-xyz",
          },
        ]);
      }),
  );

  it.effect(
    "makes no assignee or reviewer call on ready PR create or update, while explicit requestReviewers still works",
    () =>
      Effect.gen(function* () {
        const candidateQueries: Array<string | undefined> = [];
        const requestedReviewers: Array<{
          readonly reviewers: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
          readonly pinnedToken: string | null;
        }> = [];
        const ranActions: Array<string> = [];

        const harness = yield* makeToolkitHarness({
          authLayer: makeFakeAuthService({
            resolve: () => Effect.succeed(APP_DECISION),
          }),
          git: {
            createPullRequest: () =>
              Effect.succeed({
                status: "created",
                url: "https://github.com/macs-holding/shop/pull/42",
                baseBranch: "main",
                headBranch: "feat/shop",
                title: "Ready PR",
              }),
          },
          pullRequests: {
            reviewerCandidates: (input) =>
              Effect.sync(() => {
                candidateQueries.push(input.query);
                return {
                  candidates: [
                    {
                      id: "U_alice",
                      login: "alice",
                      kind: "user" as const,
                      name: "Alice",
                      avatarUrl: null,
                      isRequested: false,
                    },
                  ],
                  truncated: false,
                };
              }),
            requestReviewers: (input) =>
              Effect.gen(function* () {
                const pinned = yield* GitHubAppInstallationAuth.PinnedGitHubCredential;
                requestedReviewers.push({
                  reviewers: input.reviewers,
                  pinnedToken: pinned === null ? null : Redacted.value(pinned.token),
                });
              }),
            runAction: (input) =>
              Effect.sync(() => {
                ranActions.push(input.action);
                return undefined;
              }),
          },
        });

        const createResult = yield* harness.call("pull_request_create", {
          title: "Ready PR",
          body: "No auto-assign",
          draft: false,
        });
        expect(createResult.created).toBe(true);
        expect(createResult.actor).toBe("omegent-app[bot]");
        expect(candidateQueries).toEqual([]);
        expect(requestedReviewers).toEqual([]);

        const readyResult = yield* harness.call("pull_request_update", {
          number: 42,
          ready: true,
        });
        expect(readyResult.actor).toBe("omegent-app[bot]");
        expect(ranActions).toEqual(["ready"]);
        expect(candidateQueries).toEqual([]);
        expect(requestedReviewers).toEqual([]);

        const explicitResult = yield* harness.call("pull_request_update", {
          number: 42,
          requestReviewers: ["alice"],
        });
        expect(explicitResult.actor).toBe("omegent-app[bot]");
        expect(candidateQueries).toEqual(["alice"]);
        expect(requestedReviewers).toEqual([
          {
            reviewers: [{ id: "U_alice", kind: "user" }],
            pinnedToken: "app-token-xyz",
          },
        ]);
      }),
  );
});
