import { SourceControlProviderKind } from "@t3tools/contracts";
import type {
  SourceControlProviderInfo,
  VcsStatusChangeRequest,
  VcsStatusResult,
} from "@t3tools/contracts";

export interface ChangeRequestPresentation {
  readonly icon:
    | "github"
    | "gitlab"
    | "forgejo"
    | "azure-devops"
    | "bitbucket"
    | "gitcafe"
    | "change-request";
  readonly providerName: string;
  readonly shortName: string;
  readonly longName: string;
  readonly pluralLongName: string;
  readonly providerLongName: string;
  readonly checkoutCommandExample?: string;
  readonly urlExample: string;
}

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

export const DEFAULT_CHANGE_REQUEST_TERMINOLOGY: ChangeRequestTerminology = {
  shortLabel: "PR",
  singular: "pull request",
};

const GITHUB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "github",
  providerName: "GitHub",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "GitHub pull request",
  checkoutCommandExample: "gh pr checkout 123",
  urlExample: "https://github.com/owner/repo/pull/42",
};

const GITLAB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "gitlab",
  providerName: "GitLab",
  shortName: "MR",
  longName: "merge request",
  pluralLongName: "merge requests",
  providerLongName: "GitLab merge request",
  checkoutCommandExample: "glab mr checkout 123",
  urlExample: "https://gitlab.com/group/project/-/merge_requests/42",
};

const FORGEJO_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "forgejo",
  providerName: "Forgejo",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Forgejo pull request",
  checkoutCommandExample: "tea pr checkout 123",
  urlExample: "https://codeberg.org/owner/repo/pulls/42",
};

const AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "azure-devops",
  providerName: "Azure DevOps",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Azure DevOps pull request",
  checkoutCommandExample: "az repos pr checkout --id 123",
  urlExample: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
};

const BITBUCKET_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "bitbucket",
  providerName: "Bitbucket",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Bitbucket pull request",
  urlExample: "https://bitbucket.org/workspace/repo/pull-requests/42",
};

const GITCAFE_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "gitcafe",
  providerName: "GitCafe",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "GitCafe pull request",
  checkoutCommandExample: "cafe pr checkout 123",
  urlExample: "https://git.cafe/owner/repo/pulls/42",
};

const GENERIC_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "change-request",
  providerName: "source control",
  shortName: "change request",
  longName: "change request",
  pluralLongName: "change requests",
  providerLongName: "change request",
  urlExample: "#42",
};

export function resolveChangeRequestPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestPresentation {
  switch (provider?.kind) {
    case "github":
    case undefined:
      return GITHUB_CHANGE_REQUEST_PRESENTATION;
    case "gitlab":
      return GITLAB_CHANGE_REQUEST_PRESENTATION;
    case "forgejo":
      return FORGEJO_CHANGE_REQUEST_PRESENTATION;
    case "azure-devops":
      return AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION;
    case "bitbucket":
      return BITBUCKET_CHANGE_REQUEST_PRESENTATION;
    case "gitcafe":
      return GITCAFE_CHANGE_REQUEST_PRESENTATION;
    default:
      return GENERIC_CHANGE_REQUEST_PRESENTATION;
  }
}

function resolveChangeRequestPresentationForKind(
  kind: SourceControlProviderKind,
): ChangeRequestPresentation {
  return resolveChangeRequestPresentation({ kind, name: "", baseUrl: "" });
}

export interface ChangeRequestIndicator {
  readonly state: VcsStatusChangeRequest["state"];
  readonly number: number;
  readonly label: string;
  readonly tooltip: string;
  readonly url: string;
}

/**
 * Picks the change request that belongs to `threadBranch` out of a checkout's
 * status. The checkout may have moved on to another ref while a thread still
 * boxes the branch its change request was opened from, so a head-ref match
 * counts even when the live ref differs.
 */
export function resolveThreadChangeRequest(
  threadBranch: string | null,
  status: VcsStatusResult | null,
): VcsStatusChangeRequest | null {
  if (threadBranch === null || status === null) {
    return null;
  }
  const pr = status.pr ?? null;
  if (!pr) {
    return null;
  }
  return status.refName === threadBranch || pr.headRef === threadBranch ? pr : null;
}

/**
 * Derives the provider-agnostic wording for a change request badge. Callers map
 * {@link ChangeRequestIndicator.state} onto their own palette.
 */
export function resolveChangeRequestIndicator(
  pr: VcsStatusChangeRequest | null | undefined,
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestIndicator | null {
  if (!pr) {
    return null;
  }
  const { shortName } = resolveChangeRequestPresentation(provider);
  return {
    state: pr.state,
    number: pr.number,
    label: `${shortName} ${pr.state}`,
    tooltip: `#${pr.number} ${shortName} ${pr.state}: ${pr.title}`,
    url: pr.url,
  };
}

export function formatChangeRequestAction(
  verb: "View" | "Create",
  presentation: ChangeRequestPresentation,
): string {
  return `${verb} ${presentation.shortName}`;
}

export function formatCreateChangeRequestPhrase(presentation: ChangeRequestPresentation): string {
  return `create ${presentation.shortName}`;
}

export function getChangeRequestTerminology(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestTerminology {
  if (!provider) {
    return DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  }

  const presentation = resolveChangeRequestPresentation(provider);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

export function getChangeRequestTerminologyForKind(
  kind: SourceControlProviderKind,
): ChangeRequestTerminology {
  const presentation = resolveChangeRequestPresentationForKind(kind);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

const SCP_SSH_REMOTE_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;

export function isSshRemoteUrl(remoteUrl: string): boolean {
  const trimmed = remoteUrl.trim();
  return SCP_SSH_REMOTE_PATTERN.test(trimmed) || trimmed.toLowerCase().startsWith("ssh://");
}
