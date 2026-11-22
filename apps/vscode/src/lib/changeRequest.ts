import type { SourceControlProviderInfo, VcsStatusResult } from "@t3tools/contracts";

type VcsStatusChangeRequest = NonNullable<VcsStatusResult["pr"]>;

export interface ChangeRequestIndicator {
  readonly state: VcsStatusChangeRequest["state"];
  readonly number: number;
  readonly label: string;
  readonly tooltip: string;
  readonly url: string;
}

function changeRequestShortName(provider: SourceControlProviderInfo | null | undefined): string {
  switch (provider?.kind) {
    case undefined:
    case "github":
    case "forgejo":
    case "azure-devops":
    case "bitbucket":
    case "gitcafe":
      return "PR";
    case "gitlab":
      return "MR";
    default:
      return "change request";
  }
}

export function resolveChangeRequestIndicator(
  pr: VcsStatusChangeRequest | null | undefined,
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestIndicator | null {
  if (!pr) return null;
  const shortName = changeRequestShortName(provider);
  return {
    state: pr.state,
    number: pr.number,
    label: `${shortName} ${pr.state}`,
    tooltip: `#${pr.number} ${shortName} ${pr.state}: ${pr.title}`,
    url: pr.url,
  };
}
