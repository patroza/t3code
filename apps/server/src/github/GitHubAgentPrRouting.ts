import { SourceControlProviderKind, type OrchestrationProjectShell } from "@t3tools/contracts";
import * as GitHubAppInstallationAuth from "@t3tools/source-control-github/server/appInstallationAuth";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

export const PullRequestActorResultFields = {
  actor: Schema.optional(Schema.String).annotate({
    description:
      "GitHub account that acted (opener or reviewer App bot login, or personal login), when known.",
  }),
};

export const PULL_REQUEST_REVIEW_ROUTING_NOTE =
  " On repos with a reviewer App, routes through the reviewer App to review and approve; the author enables auto-merge or merges via pull_request_merge.";

export const PULL_REQUEST_MERGE_ROUTING_NOTE =
  " Always uses the opener App (author enables auto-merge or merges; reviewer reviews and approves via pull_request_review).";

export interface GitHubRepositoryTarget {
  readonly host: string;
  readonly repository: string;
}

export function projectGitHubTarget(
  project: OrchestrationProjectShell | undefined,
): GitHubRepositoryTarget | undefined {
  const identity = project?.repositoryIdentity;
  if (identity == null || identity.provider !== "github") return undefined;
  const host = sourceControlDefinitions.changeRequestHost(identity, identity.provider);
  const repository = sourceControlDefinitions.repositorySelector(identity);
  if (!host || !repository) return undefined;
  return { host, repository };
}

const resolvePersonalActor = Effect.fn("GitHubAgentPrRouting.resolvePersonalActor")(function* (
  host: string,
  cwd: string | undefined,
): Effect.fn.Return<string | undefined> {
  const registry = yield* Effect.serviceOption(
    PullRequestProviderRegistry.PullRequestProviderRegistry,
  );
  if (Option.isNone(registry)) return undefined;
  const github = registry.value.get(SourceControlProviderKind.make("github"));
  if (github?.getRoutingIdentity === undefined) return undefined;
  const identity = yield* github.getRoutingIdentity({ cwd: cwd ?? ".", host }).pipe(Effect.option);
  return Option.isSome(identity) ? identity.value.viewer : undefined;
});

/**
 * Route a GitHub read tool call through the configured App installation credential when
 * available, falling back to the personal credential on unlisted owners, 404, or mint failure.
 */
export const withGitHubAgentRead = Effect.fn("GitHubAgentPrRouting.withGitHubAgentRead")(function* <
  A,
  E,
  R,
>(target: GitHubRepositoryTarget | undefined, effect: Effect.Effect<A, E, R>) {
  if (target === undefined) return yield* effect;
  const auth = yield* Effect.serviceOption(GitHubAppInstallationAuth.GitHubAppInstallationAuth);
  if (Option.isNone(auth)) return yield* effect;
  const decision = yield* auth.value
    .resolve({ host: target.host, repository: target.repository, access: "read" })
    .pipe(
      Effect.orElseSucceed((): GitHubAppInstallationAuth.GitHubAppRoutingDecision => ({
        mode: "personal",
        configured: true,
      })),
    );
  if (decision.mode !== "app") return yield* effect;
  return yield* effect.pipe(
    Effect.provideService(GitHubAppInstallationAuth.PinnedGitHubCredential, {
      host: decision.host,
      token: decision.token,
      credentialFingerprint: decision.fingerprint,
      source: "app",
    }),
  );
});

export interface GitHubAgentWriteOutcome<A> {
  readonly value: A;
  readonly actor: string | undefined;
  readonly decision: GitHubAppInstallationAuth.GitHubAppRoutingDecision | undefined;
}

/**
 * Route a GitHub write tool call through the configured App installation credential
 * (using the entry's `reviewer` App when `role === "reviewer"` and configured).
 * Fails closed on configuration, key, or mint errors for mapped/installed repos; never
 * silently falls back to the opener App or personal credential.
 */
export const withGitHubAgentWrite = Effect.fn("GitHubAgentPrRouting.withGitHubAgentWrite")(
  function* <A, E, R, E2>(
    target: GitHubRepositoryTarget | undefined,
    options: {
      readonly cwd?: string | undefined;
      readonly role?: GitHubAppInstallationAuth.GitHubAppRole | undefined;
      readonly mapAuthError: (error: GitHubAppInstallationAuth.GitHubAppInstallationError) => E2;
    },
    effect: Effect.Effect<A, E, R>,
  ): Effect.fn.Return<GitHubAgentWriteOutcome<A>, E | E2, R> {
    if (target === undefined) {
      return { value: yield* effect, actor: undefined, decision: undefined };
    }
    const auth = yield* Effect.serviceOption(GitHubAppInstallationAuth.GitHubAppInstallationAuth);
    if (Option.isNone(auth)) {
      return { value: yield* effect, actor: undefined, decision: undefined };
    }
    const decision = yield* auth.value
      .resolve({
        host: target.host,
        repository: target.repository,
        access: "write",
        ...(options.role === undefined ? {} : { role: options.role }),
      })
      .pipe(Effect.mapError(options.mapAuthError));
    if (decision.mode === "app") {
      const value = yield* effect.pipe(
        Effect.provideService(GitHubAppInstallationAuth.PinnedGitHubCredential, {
          host: decision.host,
          token: decision.token,
          credentialFingerprint: decision.fingerprint,
          source: "app",
        }),
      );
      return { value, actor: decision.actor, decision };
    }
    const value = yield* effect;
    const personalLogin = decision.configured
      ? ((yield* resolvePersonalActor(target.host, options.cwd)) ?? "personal")
      : yield* resolvePersonalActor(target.host, options.cwd);
    return { value, actor: personalLogin, decision };
  },
);
