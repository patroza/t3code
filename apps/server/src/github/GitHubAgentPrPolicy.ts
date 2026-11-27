import {
  SourceControlProviderKind,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type PullRequestMergeMethod,
  type PullRequestRef,
  type PullRequestReviewVerdict,
} from "@t3tools/contracts";
import * as GitHubAppInstallationAuth from "@t3tools/source-control-github/server/appInstallationAuth";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as IdentityService from "../identity/IdentityService.ts";
import * as McpClientInput from "../mcp/McpClientInput.ts";
import * as PullRequestProviderRegistry from "../pullRequest/PullRequestProviderRegistry.ts";
import type * as PullRequestService from "../pullRequest/PullRequestService.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";

export const PullRequestActorResultFields = {
  actor: Schema.optional(Schema.String).annotate({
    description: "GitHub account that acted (App bot login or personal login), when known.",
  }),
};

export const AGENT_REVIEW_REFUSED_MESSAGE =
  "Refused: agents cannot approve or request changes on pull requests; a human must review in person.";

const MERGE_DECLINED_MESSAGE = "Refused: the human declined to merge this pull request.";
const MERGE_UNCONFIRMED_MESSAGE =
  "Refused: no human approval was confirmed for merging this pull request.";
const MERGE_UNAVAILABLE_MESSAGE =
  "Refused: agents cannot merge pull requests without explicit human approval (this client cannot prompt for approval, and T3_ALLOW_AGENT_PR_MERGE=1 is not set).";

const allowAgentPrMergeConfig = Config.String("T3_ALLOW_AGENT_PR_MERGE").pipe(
  Config.withDefault(""),
);

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

function isAgentPolicyEnabled(
  auth: Option.Option<GitHubAppInstallationAuth.GitHubAppInstallationAuth["Service"]>,
): boolean {
  return Option.isSome(auth) && auth.value.config.agentPolicy;
}

/**
 * Enforce the agent PR review policy: when enabled, agents cannot submit approving or
 * request-changes reviews (no override). Non-approving comment reviews remain allowed.
 */
export const enforceAgentReviewPolicy = Effect.fn("GitHubAgentPrPolicy.enforceAgentReviewPolicy")(
  function* <E>(
    verdict: PullRequestReviewVerdict,
    toError: (detail: string) => E,
  ): Effect.fn.Return<void, E> {
    const auth = yield* Effect.serviceOption(GitHubAppInstallationAuth.GitHubAppInstallationAuth);
    if (!isAgentPolicyEnabled(auth)) return;
    if (verdict === "approve" || verdict === "request-changes") {
      return yield* Effect.fail(toError(AGENT_REVIEW_REFUSED_MESSAGE));
    }
  },
);

function mergeApprovalState(input: {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly expectedHeadSha: string;
  readonly auto?: boolean | undefined;
  readonly method?: PullRequestMergeMethod | undefined;
}): string {
  return [
    "pr-merge",
    input.host.toLowerCase(),
    input.repository.toLowerCase(),
    String(input.number),
    input.expectedHeadSha,
    input.auto === true ? "auto" : "now",
    input.method ?? "default",
  ].join(":");
}

function mergeApprovalMessage(input: {
  readonly repository: string;
  readonly number: number;
  readonly expectedHeadSha: string;
  readonly auto?: boolean | undefined;
  readonly method?: PullRequestMergeMethod | undefined;
}): string {
  const mode = input.auto === true ? "enable auto-merge on" : "merge";
  const methodSuffix = input.method === undefined ? "" : ` (${input.method})`;
  return `Allow agent to ${mode} ${input.repository}#${input.number} at ${input.expectedHeadSha.slice(0, 12)}${methodSuffix}?`;
}

/**
 * Enforce the agent PR merge policy: when enabled, agents cannot merge unless either
 * `T3_ALLOW_AGENT_PR_MERGE=1` is set in the environment or the human explicitly approves
 * this specific PR + head SHA via MCP elicitation (`McpClientInput.askApproval`).
 */
export const enforceAgentMergePolicy = Effect.fn("GitHubAgentPrPolicy.enforceAgentMergePolicy")(
  function* <E>(
    input: {
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly expectedHeadSha: string;
      readonly auto?: boolean | undefined;
      readonly method?: PullRequestMergeMethod | undefined;
    },
    toError: (detail: string) => E,
  ): Effect.fn.Return<void, E> {
    const auth = yield* Effect.serviceOption(GitHubAppInstallationAuth.GitHubAppInstallationAuth);
    if (!isAgentPolicyEnabled(auth)) return;
    const allowMerge = yield* allowAgentPrMergeConfig.pipe(Effect.orElseSucceed(() => ""));
    if (allowMerge.trim() === "1") return;

    const state = mergeApprovalState(input);
    const reply = yield* McpClientInput.answered("pr-merge");
    if (reply !== undefined) {
      if (reply.answer === "accepted" && reply.state === state) return;
      return yield* Effect.fail(
        toError(reply.answer === "declined" ? MERGE_DECLINED_MESSAGE : MERGE_UNCONFIRMED_MESSAGE),
      );
    }

    const answer = yield* McpClientInput.askApproval({
      key: "pr-merge",
      state,
      message: mergeApprovalMessage(input),
    });
    if (answer === "accepted") return;
    if (answer === "declined") return yield* Effect.fail(toError(MERGE_DECLINED_MESSAGE));
    if (answer === "unconfirmed") return yield* Effect.fail(toError(MERGE_UNCONFIRMED_MESSAGE));
    if (answer === "unavailable") return yield* Effect.fail(toError(MERGE_UNAVAILABLE_MESSAGE));
    // "asked": McpHttpServer intercepts pending.request and sends the elicitation prompt.
    return yield* Effect.fail(toError("Waiting for human merge approval."));
  },
);

const resolvePersonalActor = Effect.fn("GitHubAgentPrPolicy.resolvePersonalActor")(function* (
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
export const withGitHubAgentRead = Effect.fn("GitHubAgentPrPolicy.withGitHubAgentRead")(function* <
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
 * Route a GitHub write tool call through the configured App installation credential.
 * Fails closed on configuration, key, or mint errors for mapped/installed repos; never
 * silently falls back to the personal credential.
 */
export const withGitHubAgentWrite = Effect.fn("GitHubAgentPrPolicy.withGitHubAgentWrite")(
  function* <A, E, R, E2>(
    target: GitHubRepositoryTarget | undefined,
    options: {
      readonly cwd?: string | undefined;
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
      .resolve({ host: target.host, repository: target.repository, access: "write" })
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

const resolveDirectingHumanGitHubLogin = Effect.fn(
  "GitHubAgentPrPolicy.resolveDirectingHumanGitHubLogin",
)(function* (
  thread: Pick<OrchestrationV2ThreadShell, "originSource">,
): Effect.fn.Return<string | undefined> {
  const origin = thread.originSource;
  if (origin == null) return undefined;
  const identity = yield* Effect.serviceOption(IdentityService.IdentityService);
  if (Option.isNone(identity)) return undefined;
  const people = yield* identity.value.listMapPeople();
  const match = people.find(
    (person) =>
      (origin.personId !== undefined && person.personId === origin.personId) ||
      (origin.username !== undefined && person.username === origin.username),
  );
  return match?.github?.login;
});

/**
 * After a PR is opened ready (non-draft) or marked ready by the GitHub App, assign the
 * directing human and request their review. Best-effort: logs warnings on failure and
 * never fails the already-succeeded PR mutation.
 */
export const assignAndRequestDirectingHuman = Effect.fn(
  "GitHubAgentPrPolicy.assignAndRequestDirectingHuman",
)(function* (input: {
  readonly thread: Pick<OrchestrationV2ThreadShell, "originSource">;
  readonly ref: PullRequestRef;
  readonly pullRequests: Pick<
    PullRequestService.PullRequestService["Service"],
    "reviewerCandidates" | "requestReviewers"
  >;
  readonly decision: GitHubAppInstallationAuth.GitHubAppRoutingDecision | undefined;
}) {
  if (input.decision?.mode !== "app") return;
  const login = yield* resolveDirectingHumanGitHubLogin(input.thread);
  if (!login) return;

  const host = input.ref.host ?? input.decision.host;
  const repository = input.ref.repository;
  const auth = yield* Effect.serviceOption(GitHubAppInstallationAuth.GitHubAppInstallationAuth);
  if (Option.isSome(auth) && repository !== undefined) {
    yield* auth.value
      .addIssueAssignees({
        host,
        repository,
        number: input.ref.number,
        assignees: [login],
        token: input.decision.token,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not assign directing human on ready PR", {
            repository,
            number: input.ref.number,
            login,
            reason: error.message,
          }),
        ),
      );
  }

  const pinned = {
    host: input.decision.host,
    token: input.decision.token,
    credentialFingerprint: input.decision.fingerprint,
    source: "app" as const,
  };
  yield* input.pullRequests.reviewerCandidates({ ...input.ref, query: login }).pipe(
    Effect.flatMap(({ candidates }) => {
      const wanted = login.toLowerCase();
      const match = candidates.find(
        (candidate) =>
          candidate.login.toLowerCase() === wanted || candidate.id.toLowerCase() === wanted,
      );
      if (match === undefined) return Effect.void;
      return input.pullRequests.requestReviewers({
        ...input.ref,
        reviewers: [{ id: match.id, kind: match.kind }],
        requested: true,
      });
    }),
    Effect.provideService(GitHubAppInstallationAuth.PinnedGitHubCredential, pinned),
    Effect.catch((error) =>
      Effect.logWarning("Could not request review from directing human on ready PR", {
        repository,
        number: input.ref.number,
        login,
        reason: error.message,
      }),
    ),
  );
});
