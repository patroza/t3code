import {
  IdentityUsername,
  PersonId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestRef,
} from "@t3tools/contracts";
import * as GitHubAppInstallationAuth from "@t3tools/source-control-github/server/appInstallationAuth";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import { McpSchema } from "effect/ai";

import * as IdentityService from "../identity/IdentityService.ts";
import * as McpClientInput from "../mcp/McpClientInput.ts";
import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import {
  AGENT_REVIEW_REFUSED_MESSAGE,
  assignAndRequestDirectingHuman,
  enforceAgentMergePolicy,
  enforceAgentReviewPolicy,
  withGitHubAgentRead,
  withGitHubAgentWrite,
} from "./GitHubAgentPrPolicy.ts";

function makeFakeAuthService(input: {
  readonly agentPolicy: boolean;
  readonly resolve: GitHubAppInstallationAuth.GitHubAppInstallationAuth["Service"]["resolve"];
  readonly assigned?: Array<{
    readonly repository: string;
    readonly number: number;
    readonly assignees: ReadonlyArray<string>;
  }>;
}) {
  return Layer.succeed(GitHubAppInstallationAuth.GitHubAppInstallationAuth, {
    config: { mode: "disabled", agentPolicy: input.agentPolicy },
    resolve: input.resolve,
    invalidate: () => Effect.void,
    addIssueAssignees: ({ repository, number, assignees }) =>
      Effect.sync(() => {
        input.assigned?.push({ repository, number, assignees });
      }),
  });
}

describe("GitHubAgentPrPolicy", () => {
  it.effect(
    "refuses approve and request-changes reviews when agent policy is on; allows comment",
    () =>
      Effect.gen(function* () {
        const layer = makeFakeAuthService({
          agentPolicy: true,
          resolve: () => Effect.succeed({ mode: "personal", configured: true }),
        });

        const approveErr = yield* enforceAgentReviewPolicy("approve", (detail) => detail).pipe(
          Effect.provide(layer),
          Effect.flip,
        );
        expect(approveErr).toBe(AGENT_REVIEW_REFUSED_MESSAGE);

        const changesErr = yield* enforceAgentReviewPolicy(
          "request-changes",
          (detail) => detail,
        ).pipe(Effect.provide(layer), Effect.flip);
        expect(changesErr).toBe(AGENT_REVIEW_REFUSED_MESSAGE);

        yield* enforceAgentReviewPolicy("comment", (detail) => detail).pipe(Effect.provide(layer));
      }),
  );

  it.effect("allows approve and merge when agent policy is off (unconfigured)", () =>
    Effect.gen(function* () {
      const layer = makeFakeAuthService({
        agentPolicy: false,
        resolve: () => Effect.succeed({ mode: "personal", configured: false }),
      });

      yield* enforceAgentReviewPolicy("approve", (detail) => detail).pipe(Effect.provide(layer));
      yield* enforceAgentMergePolicy(
        {
          host: "github.com",
          repository: "patroza/t3code",
          number: 1,
          expectedHeadSha: "abc123def456",
        },
        (detail) => detail,
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "refuses merge when agent policy is on without human override, allows with elicitation or env override",
    () =>
      Effect.gen(function* () {
        const layer = makeFakeAuthService({
          agentPolicy: true,
          resolve: () => Effect.succeed({ mode: "personal", configured: true }),
        });
        const mergeInput = {
          host: "github.com",
          repository: "macs-holding/shop",
          number: 42,
          expectedHeadSha: "deadbeef1234",
          method: "squash" as const,
        };

        const noOverrideConfig = ConfigProvider.layer(ConfigProvider.fromUnknown({}));
        const allowOverrideConfig = ConfigProvider.layer(
          ConfigProvider.fromUnknown({ T3_ALLOW_AGENT_PR_MERGE: "1" }),
        );

        // Without elicitation capability or env override -> refused
        const refused = yield* enforceAgentMergePolicy(mergeInput, (detail) => detail).pipe(
          Effect.provide(Layer.mergeAll(layer, noOverrideConfig)),
          Effect.flip,
        );
        expect(refused).toContain("Refused: agents cannot merge pull requests");

        // With elicitation capability -> asks human (sets pending.request)
        const pendingRef = yield* Ref.make<McpSchema.InputRequired | undefined>(undefined);
        const clientInputLayer = Layer.succeed(McpClientInput.McpClientInput, {
          request: pendingRef,
        });
        const requestContextLayer = Layer.succeed(McpSchema.McpRequestContext, {
          clientCapabilities: { elicitation: { form: {} } },
          clientInfo: { name: "test", version: "1.0.0" },
        } as never);
        yield* enforceAgentMergePolicy(mergeInput, (detail) => detail).pipe(
          Effect.provide(
            Layer.mergeAll(layer, noOverrideConfig, clientInputLayer, requestContextLayer),
          ),
          Effect.flip,
        );
        const asked = yield* Ref.get(pendingRef);
        expect(asked).toBeDefined();
        const requestState = asked!.requestState!;

        // Callback with human acceptance for exact state -> allowed
        const acceptedContextLayer = Layer.succeed(McpSchema.McpRequestContext, {
          clientCapabilities: { elicitation: { form: {} } },
          clientInfo: { name: "test", version: "1.0.0" },
          inputResponses: { "pr-merge": { action: "accept", content: {} } },
          requestState,
        } as never);
        yield* enforceAgentMergePolicy(mergeInput, (detail) => detail).pipe(
          Effect.provide(
            Layer.mergeAll(layer, noOverrideConfig, clientInputLayer, acceptedContextLayer),
          ),
        );

        // Callback with human decline -> refused
        const declinedContextLayer = Layer.succeed(McpSchema.McpRequestContext, {
          clientCapabilities: { elicitation: { form: {} } },
          clientInfo: { name: "test", version: "1.0.0" },
          inputResponses: { "pr-merge": { action: "decline" } },
          requestState,
        } as never);
        const declined = yield* enforceAgentMergePolicy(mergeInput, (detail) => detail).pipe(
          Effect.provide(
            Layer.mergeAll(layer, noOverrideConfig, clientInputLayer, declinedContextLayer),
          ),
          Effect.flip,
        );
        expect(declined).toContain("declined");

        // Env override T3_ALLOW_AGENT_PR_MERGE=1 -> allowed
        yield* enforceAgentMergePolicy(mergeInput, (detail) => detail).pipe(
          Effect.provide(Layer.mergeAll(layer, allowOverrideConfig)),
        );
      }),
  );

  it.effect(
    "pins PinnedGitHubCredential and reports actor for App writes and personal writes",
    () =>
      Effect.gen(function* () {
        const appLayer = makeFakeAuthService({
          agentPolicy: true,
          resolve: ({ repository }) =>
            repository.startsWith("macs-holding/")
              ? Effect.succeed({
                  mode: "app",
                  host: "github.com",
                  token: Redacted.make("app-token-xyz"),
                  fingerprint: "fp-app",
                  appId: "4331997",
                  appSlug: "omegent-app",
                  actor: "omegent-app[bot]",
                  installationId: 101,
                })
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

  it.effect("assigns and requests review from directing human when App marks PR ready", () =>
    Effect.gen(function* () {
      const assigned: Array<{
        repository: string;
        number: number;
        assignees: ReadonlyArray<string>;
      }> = [];
      const requested: Array<ReadonlyArray<{ id: string; kind: string }>> = [];
      const authLayer = makeFakeAuthService({
        agentPolicy: true,
        resolve: () => Effect.succeed({ mode: "personal", configured: true }),
        assigned,
      });
      const identityLayer = Layer.succeed(IdentityService.IdentityService, {
        listMapPeople: () =>
          Effect.succeed([
            {
              personId: "patroza",
              username: "patroza",
              github: { login: "patroza" },
            },
          ]),
      } as never);

      const ref: PullRequestRef = {
        projectId: ProjectId.make("proj-1"),
        host: "github.com",
        repository: "macs-holding/shop",
        number: 77,
      };
      const pullRequests = {
        reviewerCandidates: () =>
          Effect.succeed({
            candidates: [
              {
                id: "U_patroza",
                login: "patroza",
                kind: "user" as const,
                name: "Patrick",
                avatarUrl: null,
                requested: false,
              },
            ],
          }),
        requestReviewers: (input: {
          readonly reviewers: ReadonlyArray<{ readonly id: string; readonly kind: string }>;
        }) =>
          Effect.sync(() => {
            requested.push(input.reviewers);
          }),
      };

      const appDecision: GitHubAppInstallationAuth.GitHubAppRoutingDecision = {
        mode: "app",
        host: "github.com",
        token: Redacted.make("app-token"),
        fingerprint: "fp-app",
        appId: "4331997",
        appSlug: "omegent-app",
        actor: "omegent-app[bot]",
        installationId: 101,
      };

      yield* assignAndRequestDirectingHuman({
        thread: {
          originSource: {
            channel: "web",
            personId: PersonId.make("patroza"),
            username: IdentityUsername.make("patroza"),
          },
        },
        ref,
        pullRequests: pullRequests as never,
        decision: appDecision,
      }).pipe(Effect.provide(Layer.mergeAll(authLayer, identityLayer)));

      expect(assigned).toEqual([
        { repository: "macs-holding/shop", number: 77, assignees: ["patroza"] },
      ]);
      expect(requested).toEqual([[{ id: "U_patroza", kind: "user" }]]);

      // Personal decision does not self-assign/request
      yield* assignAndRequestDirectingHuman({
        thread: {
          originSource: {
            channel: "web",
            personId: PersonId.make("patroza"),
            username: IdentityUsername.make("patroza"),
          },
        },
        ref,
        pullRequests: pullRequests as never,
        decision: { mode: "personal", configured: true },
      }).pipe(Effect.provide(Layer.mergeAll(authLayer, identityLayer)));
      expect(assigned).toHaveLength(1);
      expect(requested).toHaveLength(1);
    }),
  );
});
