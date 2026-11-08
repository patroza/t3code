export interface GitHubStackPullRequest {
  readonly number: number;
  readonly headBranch: string;
  readonly headSha: string;
  readonly baseBranch?: string;
}

export interface GitHubPullRequestStackContext {
  readonly source: "github" | "inferred" | "exact";
  readonly stackNumber: number | null;
  readonly baseBranch: string;
  readonly pullRequests: ReadonlyArray<GitHubStackPullRequest>;
}

export function inferPullRequestStack(input: {
  readonly target: GitHubStackPullRequest & { readonly baseBranch: string };
  readonly openPullRequests: ReadonlyArray<
    GitHubStackPullRequest & { readonly baseBranch: string }
  >;
}): GitHubPullRequestStackContext {
  const byNumber = new Map(
    input.openPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]),
  );
  byNumber.set(input.target.number, input.target);
  const pullRequests = [...byNumber.values()];
  const stack = [input.target];
  const used = new Set([input.target.number]);

  let bottom = input.target;
  while (true) {
    const parents = pullRequests.filter(
      (candidate) => !used.has(candidate.number) && candidate.headBranch === bottom.baseBranch,
    );
    if (parents.length !== 1) break;
    bottom = parents[0]!;
    used.add(bottom.number);
    stack.unshift(bottom);
  }

  let top = input.target;
  while (true) {
    const children = pullRequests.filter(
      (candidate) => !used.has(candidate.number) && candidate.baseBranch === top.headBranch,
    );
    if (children.length !== 1) break;
    top = children[0]!;
    used.add(top.number);
    stack.push(top);
  }

  return {
    source: stack.length > 1 ? "inferred" : "exact",
    stackNumber: null,
    baseBranch: stack[0]!.baseBranch,
    pullRequests: stack,
  };
}

export function stackBranchesForMatching(
  context: GitHubPullRequestStackContext,
  requestedPullRequestNumber: number,
): ReadonlyArray<string> {
  const requested = context.pullRequests.find(
    (pullRequest) => pullRequest.number === requestedPullRequestNumber,
  );
  return [
    ...(requested === undefined ? [] : [requested.headBranch]),
    ...context.pullRequests
      .filter((pullRequest) => pullRequest.number !== requestedPullRequestNumber)
      .map((pullRequest) => pullRequest.headBranch),
  ];
}
