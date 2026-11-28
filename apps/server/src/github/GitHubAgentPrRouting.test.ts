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
import { HttpClient, HttpClientResponse } from "effect/http";
// @effect-diagnostics nodeBuiltinImport:off -- RSA keypair generation for offline unit tests.
import * as NodeCrypto from "node:crypto";

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

  it.effect(
    "routes pull_request_review to reviewer App while all pull_request_merge variants and create/update/respond/ci_rerun stay on opener",
    () =>
      Effect.gen(function* () {
        const openerKey = NodeCrypto.generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey;
        const reviewerKey = NodeCrypto.generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey;

        const files: Readonly<Record<string, string>> = {
          "/keys/opener.pem": openerKey,
          "/keys/reviewer.pem": reviewerKey,
          "/etc/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "/keys/opener.pem",
                owners: ["macs-holding"],
                reviewer: {
                  name: "omegent-reviewer",
                  appId: 9988776,
                  privateKeyPath: "/keys/reviewer.pem",
                },
              },
            ],
          }),
        };
        const fakeFs = FileSystem.makeNoop({
          exists: (path) => Effect.succeed(Object.prototype.hasOwnProperty.call(files, path)),
          readFileString: (path) =>
            Object.prototype.hasOwnProperty.call(files, path)
              ? Effect.succeed(files[path]!)
              : Effect.fail({ _tag: "SystemError", message: `ENOENT: ${path}` } as never),
        });
        const config = yield* GitHubAppInstallationAuth.loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json" },
          fileSystem: fakeFs,
        });
        expect(config.mode).toBe("apps-file");

        const jwtIssuer = (authHeader: string | undefined): string | null => {
          const parts = authHeader?.replace(/^Bearer\s+/iu, "").split(".");
          if (!parts || parts.length !== 3) return null;
          const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
            iss?: string;
          };
          return payload.iss ?? null;
        };

        const httpLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const iss = jwtIssuer(request.headers.authorization);
              const reply = (() => {
                if (request.url.endsWith("/repos/macs-holding/shop/installation")) {
                  return { status: 200, body: { id: iss === "9988776" ? 901 : 101 } };
                }
                if (request.url.endsWith("/app/installations/101/access_tokens")) {
                  return {
                    status: 201,
                    body: { token: "tok-opener", expires_at: "2099-01-01T01:00:00Z" },
                  };
                }
                if (request.url.endsWith("/app/installations/901/access_tokens")) {
                  return {
                    status: 201,
                    body: { token: "tok-reviewer", expires_at: "2099-01-01T01:00:00Z" },
                  };
                }
                if (request.url.endsWith("/app")) {
                  return {
                    status: 200,
                    body: { slug: iss === "9988776" ? "omegent-reviewer" : "omegent-app" },
                  };
                }
                return { status: 404, body: {} };
              })();
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(reply.body), {
                  status: reply.status,
                  headers: { "content-type": "application/json" },
                }),
              );
            }),
          ),
        );

        const authLayer = GitHubAppInstallationAuth.layer.pipe(
          Layer.provide(
            Layer.succeed(GitHubAppInstallationAuth.GitHubAppInstallationAuthConfig, config),
          ),
          Layer.provide(Layer.succeed(FileSystem.FileSystem, fakeFs)),
          Layer.provide(httpLayer),
        );

        const recordedTokens: Array<{ readonly op: string; readonly token: string | null }> = [];
        const recordToken = (op: string) =>
          Effect.map(GitHubAppInstallationAuth.PinnedGitHubCredential, (pinned) => {
            recordedTokens.push({
              op,
              token: pinned === null ? null : Redacted.value(pinned.token),
            });
          });

        const harness = yield* makeToolkitHarness({
          authLayer,
          git: {
            createPullRequest: () =>
              recordToken("create").pipe(
                Effect.as({
                  status: "created" as const,
                  url: "https://github.com/macs-holding/shop/pull/42",
                  baseBranch: "main",
                  headBranch: "feat/shop",
                  title: "Shop PR",
                }),
              ),
          },
          pullRequests: {
            diff: () =>
              recordToken("diff").pipe(
                Effect.as({
                  patch: [
                    "diff --git a/src/app.ts b/src/app.ts",
                    "--- a/src/app.ts",
                    "+++ b/src/app.ts",
                    "@@ -1,2 +1,2 @@",
                    " const a = 1;",
                    "+const b = 2;",
                  ].join("\n"),
                  truncated: false,
                  nextCursor: null,
                }),
              ),
            submitReview: (input) => recordToken(`review:${input.verdict}`),
            update: () => recordToken("update"),
            comment: () => recordToken("respond"),
            rerunChecks: () =>
              recordToken("ci_rerun").pipe(
                Effect.as([{ name: "Check", rerun: true, detail: null }]),
              ),
            stack: () =>
              recordToken("stack").pipe(
                Effect.as({
                  id: "stack-1",
                  number: 1,
                  url: "https://github.com/macs-holding/shop/pull/42",
                  base: "main",
                  layers: [
                    {
                      number: 42,
                      state: "open" as const,
                      headSha: "deadbeef1234",
                      headBranch: "feat/shop",
                      title: "Shop PR",
                      isDraft: false,
                    },
                  ],
                }),
              ),
            runAction: (input) => recordToken(`action:${input.action}`).pipe(Effect.as(undefined)),
            summary: () =>
              recordToken("summary").pipe(
                Effect.as({
                  provider: SourceControlProviderKind.make("github"),
                  projectId: PROJECT_ID,
                  repository: "macs-holding/shop",
                  number: 42,
                  title: "Shop PR",
                  url: "https://github.com/macs-holding/shop/pull/42",
                  baseBranch: "main",
                  headBranch: "feat/shop",
                  state: "merged" as const,
                  isDraft: false,
                  headSha: "deadbeef1234",
                  updatedAt: "2026-08-27T00:00:00.000Z",
                }),
              ),
          },
        });

        const createRes = yield* harness.call("pull_request_create", {
          title: "Shop PR",
          body: "body",
        });
        expect(createRes.actor).toBe("omegent-app[bot]");

        const updateRes = yield* harness.call("pull_request_update", {
          number: 42,
          title: "Updated",
        });
        expect(updateRes.actor).toBe("omegent-app[bot]");

        const respondRes = yield* harness.call("pull_request_respond", {
          number: 42,
          body: "Thanks!",
        });
        expect(respondRes.actor).toBe("omegent-app[bot]");

        yield* harness.call("ci_rerun", { number: 42 });

        const approveRes = yield* harness.call("pull_request_review", {
          number: 42,
          verdict: "approve",
          expectedHeadSha: "deadbeef1234",
          body: "LGTM",
          comments: [{ path: "src/app.ts", line: 2, body: "Nice addition" }],
        });
        expect(approveRes.actor).toBe("omegent-reviewer[bot]");

        const requestChangesRes = yield* harness.call("pull_request_review", {
          number: 42,
          verdict: "request-changes",
          body: "Fix this",
        });
        expect(requestChangesRes.actor).toBe("omegent-reviewer[bot]");

        const commentReviewRes = yield* harness.call("pull_request_review", {
          number: 42,
          verdict: "comment",
          body: "Just a note",
        });
        expect(commentReviewRes.actor).toBe("omegent-reviewer[bot]");

        const mergeRes = yield* harness.call("pull_request_merge", {
          number: 42,
          expectedHeadSha: "deadbeef1234",
        });
        expect(mergeRes.actor).toBe("omegent-app[bot]");

        const autoMergeRes = yield* harness.call("pull_request_merge", {
          number: 42,
          expectedHeadSha: "deadbeef1234",
          auto: true,
        });
        expect(autoMergeRes.actor).toBe("omegent-app[bot]");

        const stackMergeRes = yield* harness.call("pull_request_merge", {
          number: 42,
          expectedHeadSha: "deadbeef1234",
          stack: true,
        });
        expect(stackMergeRes.actor).toBe("omegent-app[bot]");

        expect(recordedTokens).toEqual([
          { op: "create", token: "tok-opener" },
          { op: "update", token: "tok-opener" },
          { op: "respond", token: "tok-opener" },
          { op: "ci_rerun", token: "tok-opener" },
          { op: "diff", token: "tok-reviewer" },
          { op: "review:approve", token: "tok-reviewer" },
          { op: "review:request-changes", token: "tok-reviewer" },
          { op: "review:comment", token: "tok-reviewer" },
          { op: "action:merge", token: "tok-opener" },
          { op: "summary", token: "tok-opener" },
          { op: "action:enable-auto-merge", token: "tok-opener" },
          { op: "summary", token: "tok-opener" },
          { op: "stack", token: "tok-opener" },
          { op: "action:merge", token: "tok-opener" },
          { op: "summary", token: "tok-opener" },
        ]);
      }),
  );

  it.effect(
    "fails pull_request_review closed when reviewer App fails, while all pull_request_merge calls use opener App and fail closed if opener fails",
    () =>
      Effect.gen(function* () {
        let submitted = false;
        const ranActions: Array<string> = [];
        const reviewerFailingHarness = yield* makeToolkitHarness({
          authLayer: makeFakeAuthService({
            resolve: ({ role }) =>
              role === "reviewer"
                ? Effect.fail(
                    new GitHubAppInstallationAuth.GitHubAppInstallationError({
                      operation: "lookup-installation",
                      status: 404,
                      detail:
                        "reviewer omegent-reviewer (App 9988776) is not installed on macs-holding/shop; refusing to fall back to opener App or personal account.",
                    }),
                  )
                : Effect.succeed(APP_DECISION),
          }),
          pullRequests: {
            submitReview: () =>
              Effect.sync(() => {
                submitted = true;
              }),
            runAction: (input) =>
              Effect.sync(() => {
                ranActions.push(input.action);
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
                state: "open",
                isDraft: false,
                headSha: "deadbeef1234",
                updatedAt: "2026-08-27T00:00:00.000Z",
              }),
          },
        });

        const reviewError = yield* reviewerFailingHarness
          .call("pull_request_review", {
            number: 42,
            verdict: "approve",
            expectedHeadSha: "deadbeef1234",
            body: "LGTM",
          })
          .pipe(Effect.flip);

        expect(reviewError.message).toContain("reviewer omegent-reviewer");
        expect(submitted).toBe(false);

        // Both direct merge and auto-merge use opener App, so they succeed even when reviewer fails
        const directMergeRes = yield* reviewerFailingHarness.call("pull_request_merge", {
          number: 42,
          expectedHeadSha: "deadbeef1234",
        });
        expect(directMergeRes.actor).toBe("omegent-app[bot]");

        const autoMergeRes = yield* reviewerFailingHarness.call("pull_request_merge", {
          number: 42,
          expectedHeadSha: "deadbeef1234",
          auto: true,
        });
        expect(autoMergeRes.actor).toBe("omegent-app[bot]");
        expect(ranActions).toEqual(["merge", "enable-auto-merge"]);

        // pull_request_merge fails closed when opener App fails
        let openerRanAction = false;
        const openerFailingHarness = yield* makeToolkitHarness({
          authLayer: makeFakeAuthService({
            resolve: () =>
              Effect.fail(
                new GitHubAppInstallationAuth.GitHubAppInstallationError({
                  operation: "mint-installation-token",
                  status: 500,
                  detail:
                    "Failed to mint GitHub App installation token for omegent-app (App 4331997) on macs-holding/shop (HTTP 500).",
                }),
              ),
          }),
          pullRequests: {
            runAction: () =>
              Effect.sync(() => {
                openerRanAction = true;
                return undefined;
              }),
          },
        });

        const mergeErr = yield* openerFailingHarness
          .call("pull_request_merge", {
            number: 42,
            expectedHeadSha: "deadbeef1234",
          })
          .pipe(Effect.flip);

        expect(mergeErr.message).toContain("omegent-app");
        expect(openerRanAction).toBe(false);
      }),
  );

  it.effect(
    "routes smart's 3-entry live list so review hits shop-reviewer on shop, omegent-reviewer on other macs-holding/aaaomega/patroza repos, scrapline-reviewer on scrapline-hq, and merge stays on opener everywhere",
    () =>
      Effect.gen(function* () {
        const keyA = NodeCrypto.generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey;
        const keyB = NodeCrypto.generateKeyPairSync("rsa", {
          modulusLength: 2048,
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey;

        const files: Readonly<Record<string, string>> = {
          "/home/smart/.config/t3/github-app/private-key.pem": keyA,
          "/home/smart/.config/t3/github-app-shop-reviewer/private-key.pem": keyB,
          "/home/smart/.config/t3/github-app-omegent-reviewer/private-key.pem": keyB,
          "/home/smart/.config/t3/github-app-scrapline/private-key.pem": keyA,
          "/home/smart/.config/t3/github-app-scrapline-reviewer/private-key.pem": keyB,
          "/home/smart/.config/t3/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "~/.config/t3/github-app/private-key.pem",
                owners: ["macs-holding", "aaaomega"],
                repos: ["patroza/effect-ui-ssr-lazy-routes", "patroza/t3code"],
                reviewer: {
                  name: "omegent-reviewer",
                  appId: 5966233,
                  privateKeyPath: "~/.config/t3/github-app-omegent-reviewer/private-key.pem",
                },
              },
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "~/.config/t3/github-app/private-key.pem",
                repos: ["macs-holding/shop"],
                reviewer: {
                  name: "shop-reviewer",
                  appId: 5906950,
                  privateKeyPath: "~/.config/t3/github-app-shop-reviewer/private-key.pem",
                },
              },
              {
                name: "scrapline-multica",
                appId: 5677773,
                privateKeyPath: "~/.config/t3/github-app-scrapline/private-key.pem",
                owners: ["scrapline-hq"],
                reviewer: {
                  name: "scrapline-reviewer",
                  appId: 5729514,
                  privateKeyPath: "~/.config/t3/github-app-scrapline-reviewer/private-key.pem",
                },
              },
            ],
          }),
        };
        const fakeFs = FileSystem.makeNoop({
          exists: (path) => Effect.succeed(Object.prototype.hasOwnProperty.call(files, path)),
          readFileString: (path) =>
            Object.prototype.hasOwnProperty.call(files, path)
              ? Effect.succeed(files[path]!)
              : Effect.fail({ _tag: "SystemError", message: `ENOENT: ${path}` } as never),
        });
        const config = yield* GitHubAppInstallationAuth.loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "~/.config/t3/github-apps.json" },
          homeDir: "/home/smart",
          fileSystem: fakeFs,
        });

        const jwtIssuer = (authHeader: string | undefined): string | null => {
          const parts = authHeader?.replace(/^Bearer\s+/iu, "").split(".");
          if (!parts || parts.length !== 3) return null;
          const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
            iss?: string;
          };
          return payload.iss ?? null;
        };

        const httpLayer = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const iss = jwtIssuer(request.headers.authorization) ?? "unknown";
              const reply = (() => {
                if (request.url.endsWith("/installation")) {
                  return { status: 200, body: { id: Number(iss) } };
                }
                if (request.url.endsWith("/access_tokens")) {
                  return {
                    status: 201,
                    body: { token: `tok-${iss}`, expires_at: "2099-01-01T01:00:00Z" },
                  };
                }
                if (request.url.endsWith("/app")) {
                  const slugs: Record<string, string> = {
                    "4331997": "omegent-app",
                    "5906950": "shop-reviewer",
                    "5966233": "omegent-reviewer",
                    "5677773": "scrapline-multica",
                    "5729514": "scrapline-reviewer",
                  };
                  return { status: 200, body: { slug: slugs[iss] ?? "unknown" } };
                }
                return { status: 404, body: {} };
              })();
              return HttpClientResponse.fromWeb(
                request,
                new Response(JSON.stringify(reply.body), {
                  status: reply.status,
                  headers: { "content-type": "application/json" },
                }),
              );
            }),
          ),
        );

        const authLayer = GitHubAppInstallationAuth.layer.pipe(
          Layer.provide(
            Layer.succeed(GitHubAppInstallationAuth.GitHubAppInstallationAuthConfig, config),
          ),
          Layer.provide(Layer.succeed(FileSystem.FileSystem, fakeFs)),
          Layer.provide(httpLayer),
        );

        const recorded: Array<{
          readonly op: string;
          readonly repo: string;
          readonly token: string | null;
        }> = [];
        const record = (op: string, repo: string) =>
          Effect.map(GitHubAppInstallationAuth.PinnedGitHubCredential, (pinned) => {
            recorded.push({
              op,
              repo,
              token: pinned === null ? null : Redacted.value(pinned.token),
            });
          });

        const harness = yield* makeToolkitHarness({
          authLayer,
          pullRequests: {
            submitReview: (input) => record("review", input.repository),
            runAction: (input) => record("merge", input.repository).pipe(Effect.as(undefined)),
            summary: (input) =>
              Effect.succeed({
                provider: SourceControlProviderKind.make("github"),
                projectId: PROJECT_ID,
                repository: input.repository,
                number: input.number,
                title: "PR",
                url: `https://github.com/${input.repository}/pull/${input.number}`,
                baseBranch: "main",
                headBranch: "feat/test",
                state: "merged",
                isDraft: false,
                headSha: "deadbeef1234",
                updatedAt: "2026-08-27T00:00:00.000Z",
              }),
          },
        });

        const cases = [
          {
            repository: "macs-holding/shop",
            reviewActor: "shop-reviewer[bot]",
            reviewToken: "tok-5906950",
            mergeActor: "omegent-app[bot]",
            mergeToken: "tok-4331997",
          },
          {
            repository: "patroza/t3code",
            reviewActor: "omegent-reviewer[bot]",
            reviewToken: "tok-5966233",
            mergeActor: "omegent-app[bot]",
            mergeToken: "tok-4331997",
          },
          {
            repository: "patroza/effect-ui-ssr-lazy-routes",
            reviewActor: "omegent-reviewer[bot]",
            reviewToken: "tok-5966233",
            mergeActor: "omegent-app[bot]",
            mergeToken: "tok-4331997",
          },
          {
            repository: "scrapline-hq/scrapline",
            reviewActor: "scrapline-reviewer[bot]",
            reviewToken: "tok-5729514",
            mergeActor: "scrapline-multica[bot]",
            mergeToken: "tok-5677773",
          },
          {
            repository: "macs-holding/other",
            reviewActor: "omegent-reviewer[bot]",
            reviewToken: "tok-5966233",
            mergeActor: "omegent-app[bot]",
            mergeToken: "tok-4331997",
          },
          {
            repository: "aaaomega/ops",
            reviewActor: "omegent-reviewer[bot]",
            reviewToken: "tok-5966233",
            mergeActor: "omegent-app[bot]",
            mergeToken: "tok-4331997",
          },
        ] as const;

        for (const c of cases) {
          const rev = yield* harness.call("pull_request_review", {
            repository: c.repository,
            number: 10,
            verdict: "approve",
            expectedHeadSha: "deadbeef1234",
            body: "LGTM",
          });
          expect(rev.actor).toBe(c.reviewActor);

          const mrg = yield* harness.call("pull_request_merge", {
            repository: c.repository,
            number: 10,
            expectedHeadSha: "deadbeef1234",
          });
          expect(mrg.actor).toBe(c.mergeActor);
        }

        expect(recorded).toEqual(
          cases.flatMap((c) => [
            { op: "review", repo: c.repository, token: c.reviewToken },
            { op: "merge", repo: c.repository, token: c.mergeToken },
          ]),
        );
      }),
  );
});
