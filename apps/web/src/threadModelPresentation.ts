import type { ModelSelection, ProviderDriverKind, ServerConfig } from "@t3tools/contracts";

import { getDisplayModelName } from "./components/chat/providerIconUtils";
import { deriveProviderInstanceEntries } from "./providerInstances";

export interface ThreadModelPresentation {
  readonly driverKind: ProviderDriverKind | null;
  readonly providerLabel: string;
  readonly modelLabel: string;
  readonly tooltip: string;
}

export function resolveThreadModelPresentation(
  modelSelection: ModelSelection,
  serverConfig: ServerConfig | null | undefined,
): ThreadModelPresentation {
  const providerEntry =
    serverConfig === null || serverConfig === undefined
      ? undefined
      : deriveProviderInstanceEntries(serverConfig.providers).find(
          (entry) => entry.instanceId === modelSelection.instanceId,
        );

  const matchedModel =
    providerEntry === undefined
      ? undefined
      : providerEntry.models.find((model) => model.slug === modelSelection.model);

  const providerLabel = providerEntry?.displayName ?? modelSelection.instanceId;
  const modelLabel = matchedModel
    ? getDisplayModelName(matchedModel, { preferShortName: true })
    : modelSelection.model;
  const tooltip =
    matchedModel !== undefined && matchedModel.slug !== modelLabel
      ? `${providerLabel} · ${modelLabel} (${matchedModel.slug})`
      : `${providerLabel} · ${modelLabel}`;

  return {
    driverKind: providerEntry?.driverKind ?? null,
    providerLabel,
    modelLabel,
    tooltip,
  };
}
