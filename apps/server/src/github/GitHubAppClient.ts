import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { GitHubAppConfig } from "./GitHubAppConfig.ts";
import { createGitHubAppJwt } from "./GitHubWebhookSecurity.ts";
import {
  type GitHubPullRequestStackContext,
  inferPullRequestStack,
} from "./GitHubPullRequestStack.ts";

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";

const InstallationTokenResponse = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String,
});

const PermissionResponse = Schema.Struct({
  permission: Schema.String,
});

const CommentResponse = Schema.Struct({
  id: Schema.Number,
  html_url: Schema.String,
});

const ReactionResponse = Schema.Struct({
  id: Schema.Number,
});

const PullRequestStackSummary = Schema.Struct({
  number: Schema.Number,
  base: Schema.Struct({ ref: Schema.String }),
});

const PullRequestResponse = Schema.Struct({
  number: Schema.Number,
  head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
  base: Schema.Struct({ ref: Schema.String }),
  stack: Schema.optional(Schema.NullOr(PullRequestStackSummary)),
});

const PullRequestListResponse = Schema.Array(PullRequestResponse);

const StackResponse = Schema.Struct({
  number: Schema.Number,
  base: Schema.Struct({ ref: Schema.String }),
  pull_requests: Schema.Array(
    Schema.Struct({
      number: Schema.Number,
      head: Schema.Struct({ ref: Schema.String, sha: Schema.String }),
    }),
  ),
});

export interface GitHubComment {
  readonly id: number;
  readonly url: string;
}

export class GitHubAppClientError extends Schema.TaggedErrorClass<GitHubAppClientError>()(
  "GitHubAppClientError",
  {
    operation: Schema.String,
    status: Schema.NullOr(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.status === null
      ? `GitHub App request failed during ${this.operation}.`
      : `GitHub App request failed during ${this.operation} with HTTP ${this.status}.`;
  }
}

export class GitHubAppClient extends Context.Service<
  GitHubAppClient,
  {
    readonly repositoryPermission: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly actorLogin: string;
    }) => Effect.Effect<string, GitHubAppClientError>;
    readonly createComment: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly pullRequestNumber: number;
      readonly body: string;
    }) => Effect.Effect<GitHubComment, GitHubAppClientError>;
    readonly updateComment: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly commentId: number;
      readonly body: string;
    }) => Effect.Effect<GitHubComment, GitHubAppClientError>;
    readonly addCommentReaction: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly commentId: number;
      readonly content: "eyes";
    }) => Effect.Effect<number, GitHubAppClientError>;
    readonly deleteCommentReaction: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly commentId: number;
      readonly reactionId: number;
    }) => Effect.Effect<void, GitHubAppClientError>;
    /** Reply in an inline review-comment thread (Files changed). */
    readonly createReviewCommentReply: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly pullRequestNumber: number;
      readonly inReplyToCommentId: number;
      readonly body: string;
    }) => Effect.Effect<GitHubComment, GitHubAppClientError>;
    readonly updateReviewComment: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly commentId: number;
      readonly body: string;
    }) => Effect.Effect<GitHubComment, GitHubAppClientError>;
    readonly addReviewCommentReaction: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly commentId: number;
      readonly content: "eyes";
    }) => Effect.Effect<number, GitHubAppClientError>;
    readonly deleteReviewCommentReaction: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly commentId: number;
      readonly reactionId: number;
    }) => Effect.Effect<void, GitHubAppClientError>;
    readonly pullRequestStack: (input: {
      readonly installationId: number;
      readonly repository: string;
      readonly pullRequestNumber: number;
    }) => Effect.Effect<GitHubPullRequestStackContext, GitHubAppClientError>;
  }
>()("t3/github/GitHubAppClient") {}

interface CachedInstallationToken {
  readonly token: string;
  readonly expiresAtMs: number;
}

function repositoryPath(repository: string): string {
  return repository
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export const make = Effect.gen(function* () {
  const config = yield* GitHubAppConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const tokenCache = yield* Ref.make(new Map<number, CachedInstallationToken>());

  const executeJson = <S extends Schema.Top>(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], GitHubAppClientError, S["DecodingServices"]> =>
    httpClient
      .execute(
        request.pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders({
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": "t3-code-github-app",
          }),
        ),
      )
      .pipe(
        Effect.mapError((cause) => new GitHubAppClientError({ operation, status: null, cause })),
        Effect.flatMap((response) =>
          HttpClientResponse.matchStatus({
            "2xx": (success) =>
              HttpClientResponse.schemaBodyJson(schema)(success).pipe(
                Effect.mapError(
                  (cause) => new GitHubAppClientError({ operation, status: success.status, cause }),
                ),
              ),
            orElse: (failure) =>
              failure.text.pipe(
                Effect.ignore,
                Effect.andThen(
                  Effect.fail(new GitHubAppClientError({ operation, status: failure.status })),
                ),
              ),
          })(response),
        ),
      );

  const installationToken = Effect.fn("GitHubAppClient.installationToken")(function* (
    installationId: number,
  ) {
    if (!config.enabled) {
      return yield* new GitHubAppClientError({ operation: "configuration", status: null });
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(tokenCache)).get(installationId);
    if (cached && cached.expiresAtMs - nowMs > 60_000) return cached.token;

    const privateKey = yield* fileSystem
      .readFileString(config.privateKeyPath)
      .pipe(
        Effect.mapError(
          (cause) =>
            new GitHubAppClientError({ operation: "read-private-key", status: null, cause }),
        ),
      );
    const jwt = yield* Effect.try({
      try: () =>
        createGitHubAppJwt({
          appId: config.appId,
          privateKey,
          nowSeconds: Math.floor(nowMs / 1_000),
        }),
      catch: (cause) =>
        new GitHubAppClientError({ operation: "sign-app-jwt", status: null, cause }),
    });
    const response = yield* executeJson(
      "create-installation-token",
      HttpClientRequest.post(
        `${GITHUB_API_URL}/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`,
      ).pipe(HttpClientRequest.bearerToken(jwt), HttpClientRequest.bodyJsonUnsafe({})),
      InstallationTokenResponse,
    );
    yield* Ref.update(tokenCache, (cache) => {
      const next = new Map(cache);
      next.set(installationId, {
        token: response.token,
        expiresAtMs: nowMs + 5 * 60_000,
      });
      return next;
    });
    return response.token;
  });

  const executeVoid = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<void, GitHubAppClientError> =>
    httpClient
      .execute(
        request.pipe(
          HttpClientRequest.acceptJson,
          HttpClientRequest.setHeaders({
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": "t3-code-github-app",
          }),
        ),
      )
      .pipe(
        Effect.mapError((cause) => new GitHubAppClientError({ operation, status: null, cause })),
        Effect.flatMap(
          HttpClientResponse.matchStatus({
            "2xx": () => Effect.void,
            orElse: (failure) =>
              Effect.fail(new GitHubAppClientError({ operation, status: failure.status })),
          }),
        ),
      );

  const authenticatedRequest = Effect.fn("GitHubAppClient.authenticatedRequest")(function* (
    installationId: number,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    const token = yield* installationToken(installationId);
    return request.pipe(HttpClientRequest.bearerToken(token));
  });

  return GitHubAppClient.of({
    pullRequestStack: Effect.fn("GitHubAppClient.pullRequestStack")(function* (input) {
      const repository = repositoryPath(input.repository);
      const pullRequestRequest = yield* authenticatedRequest(
        input.installationId,
        HttpClientRequest.get(
          `${GITHUB_API_URL}/repos/${repository}/pulls/${input.pullRequestNumber}`,
        ),
      );
      const pullRequest = yield* executeJson(
        "get-pull-request-stack",
        pullRequestRequest,
        PullRequestResponse,
      );

      if (pullRequest.stack !== undefined && pullRequest.stack !== null) {
        const stackRequest = yield* authenticatedRequest(
          input.installationId,
          HttpClientRequest.get(
            `${GITHUB_API_URL}/repos/${repository}/stacks/${pullRequest.stack.number}`,
          ),
        );
        const stack = yield* executeJson("get-stack", stackRequest, StackResponse);
        return {
          source: "github" as const,
          stackNumber: stack.number,
          baseBranch: stack.base.ref,
          pullRequests: stack.pull_requests.map((candidate) => ({
            number: candidate.number,
            headBranch: candidate.head.ref,
            headSha: candidate.head.sha,
          })),
        };
      }

      const openPullRequests = yield* Effect.gen(function* () {
        const collected: Array<typeof PullRequestResponse.Type> = [];
        for (let page = 1; ; page += 1) {
          const request = yield* authenticatedRequest(
            input.installationId,
            HttpClientRequest.get(
              `${GITHUB_API_URL}/repos/${repository}/pulls?state=open&per_page=100&page=${page}`,
            ),
          );
          const response = yield* executeJson(
            "list-open-pull-requests-for-stack-inference",
            request,
            PullRequestListResponse,
          );
          collected.push(...response);
          if (response.length < 100) break;
        }
        return collected;
      });
      return inferPullRequestStack({
        target: {
          number: pullRequest.number,
          headBranch: pullRequest.head.ref,
          headSha: pullRequest.head.sha,
          baseBranch: pullRequest.base.ref,
        },
        openPullRequests: openPullRequests.map((candidate) => ({
          number: candidate.number,
          headBranch: candidate.head.ref,
          headSha: candidate.head.sha,
          baseBranch: candidate.base.ref,
        })),
      });
    }),
    repositoryPermission: Effect.fn("GitHubAppClient.repositoryPermission")(function* (input) {
      const request = yield* authenticatedRequest(
        input.installationId,
        HttpClientRequest.get(
          `${GITHUB_API_URL}/repos/${repositoryPath(input.repository)}/collaborators/${encodeURIComponent(input.actorLogin)}/permission`,
        ),
      );
      const response = yield* executeJson("repository-permission", request, PermissionResponse);
      return response.permission;
    }),
    createComment: Effect.fn("GitHubAppClient.createComment")(function* (input) {
      const request = yield* authenticatedRequest(
        input.installationId,
        HttpClientRequest.post(
          `${GITHUB_API_URL}/repos/${repositoryPath(input.repository)}/issues/${input.pullRequestNumber}/comments`,
        ).pipe(HttpClientRequest.bodyJsonUnsafe({ body: input.body })),
      );
      const response = yield* executeJson("create-comment", request, CommentResponse);
      return { id: response.id, url: response.html_url };
    }),
    updateComment: Effect.fn("GitHubAppClient.updateComment")(function* (input) {
      const request = yield* authenticatedRequest(
        input.installationId,
        HttpClientRequest.patch(
          `${GITHUB_API_URL}/repos/${repositoryPath(input.repository)}/issues/comments/${input.commentId}`,
        ).pipe(HttpClientRequest.bodyJsonUnsafe({ body: input.body })),
      );
      const response = yield* executeJson("update-comment", request, CommentResponse);
      return { id: response.id, url: response.html_url };
    }),
    addCommentReaction: Effect.fn("GitHubAppClient.addCommentReaction")(function* (input) {
      const request = yield* authenticatedRequest(
        input.installationId,
        HttpClientRequest.post(
          `${GITHUB_API_URL}/repos/${repositoryPath(input.repository)}/issues/comments/${input.commentId}/reactions`,
        ).pipe(HttpClientRequest.bodyJsonUnsafe({ content: input.content })),
      );
      const response = yield* executeJson("add-comment-reaction", request, ReactionResponse);
      return response.id;
    }),
    deleteCommentReaction: Effect.fn("GitHubAppClient.deleteCommentReaction")(function* (input) {
      const request = yield* authenticatedRequest(
        input.installationId,
        HttpClientRequest.delete(
          `${GITHUB_API_URL}/repos/${repositoryPath(input.repository)}/issues/comments/${input.commentId}/reactions/${input.reactionId}`,
        ),
      );
      yield* executeVoid("delete-comment-reaction", request);
    }),
    createReviewCommentReply: Effect.fn("GitHubAppClient.createReviewCommentReply")(
      function* (input) {
        const request = yield* authenticatedRequest(
          input.installationId,
          HttpClientRequest.post(
            `${GITHUB_API_URL}/repos/${repositoryPath(input.repository)}/pulls/${input.pullRequestNumber}/comments/${input.inReplyToCommentId}/replies`,
          ).pipe(HttpClientRequest.bodyJsonUnsafe({ body: input.body })),
        );
        const response = yield* executeJson(
          "create-review-comment-reply",
          request,
          CommentResponse,
        );
        return { id: response.id, url: response.html_url };
      },
    ),
    updateReviewComment: Effect.fn("GitHubAppClient.updateReviewComment")(function* (input) {
      const request = yield* authenticatedRequest(
        input.installationId,
        HttpClientRequest.patch(
          `${GITHUB_API_URL}/repos/${repositoryPath(input.repository)}/pulls/comments/${input.commentId}`,
        ).pipe(HttpClientRequest.bodyJsonUnsafe({ body: input.body })),
      );
      const response = yield* executeJson("update-review-comment", request, CommentResponse);
      return { id: response.id, url: response.html_url };
    }),
    addReviewCommentReaction: Effect.fn("GitHubAppClient.addReviewCommentReaction")(
      function* (input) {
        const request = yield* authenticatedRequest(
          input.installationId,
          HttpClientRequest.post(
            `${GITHUB_API_URL}/repos/${repositoryPath(input.repository)}/pulls/comments/${input.commentId}/reactions`,
          ).pipe(HttpClientRequest.bodyJsonUnsafe({ content: input.content })),
        );
        const response = yield* executeJson(
          "add-review-comment-reaction",
          request,
          ReactionResponse,
        );
        return response.id;
      },
    ),
    deleteReviewCommentReaction: Effect.fn("GitHubAppClient.deleteReviewCommentReaction")(
      function* (input) {
        const request = yield* authenticatedRequest(
          input.installationId,
          HttpClientRequest.delete(
            `${GITHUB_API_URL}/repos/${repositoryPath(input.repository)}/pulls/comments/${input.commentId}/reactions/${input.reactionId}`,
          ),
        );
        yield* executeVoid("delete-review-comment-reaction", request);
      },
    ),
  });
});

export const layer = Layer.effect(GitHubAppClient, make);
