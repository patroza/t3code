import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";

/**
 * Channel-topic tag. A project channel whose topic contains this token starts
 * new threads in fast mode (Claude/Codex fast option, or Grok's `-build-fast` model).
 */
export const FAST_MODE_TOPIC_TAG = "omegent-fast-mode";

/** `omegent-default-model-<name>`. The rest of the token is the model name. */
export const DEFAULT_MODEL_TOPIC_PREFIX = "omegent-default-model-";

const GROK_FAST_MODEL_SUFFIX = "-build-fast";

function normalizeTopicToken(token: string): string {
  return token.replace(/^[^a-z0-9]+|[^a-z0-9]+$/giu, "").toLowerCase();
}

/**
 * Structural slice of a provider snapshot. `capabilities` uses the contract
 * type so a `ServerProvider` snapshot assigns under exactOptionalPropertyTypes.
 */
export interface FastModeCatalogProvider {
  readonly instanceId: ModelSelection["instanceId"];
  readonly driver: string;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly capabilities?: ModelCapabilities | null;
  }>;
}

/** True when a channel topic includes the fast-mode tag as its own token. */
export function topicRequestsFastMode(topic: string | null | undefined): boolean {
  if (topic === null || topic === undefined || topic.length === 0) return false;
  return topic.split(/\s+/u).some((token) => normalizeTopicToken(token) === FAST_MODE_TOPIC_TAG);
}

/**
 * Model name from `omegent-default-model-<name>`, or null when the tag is absent.
 * The name may contain hyphens and dots (`opus-5.5`, `gpt-6.1-sol`). The first
 * tag wins. A bare `omegent-default-model` is not a tag.
 */
export function topicDefaultModel(topic: string | null | undefined): string | null {
  if (topic === null || topic === undefined || topic.length === 0) return null;
  for (const token of topic.split(/\s+/u)) {
    const normalized = normalizeTopicToken(token);
    if (!normalized.startsWith(DEFAULT_MODEL_TOPIC_PREFIX)) continue;
    const model = normalized.slice(DEFAULT_MODEL_TOPIC_PREFIX.length);
    if (model.length === 0) continue;
    return model;
  }
  return null;
}

function withOption(selection: ModelSelection, option: ProviderOptionSelection): ModelSelection {
  const options = (selection.options ?? []).filter((entry) => entry.id !== option.id);
  return { ...selection, options: [...options, option] };
}

function descriptorsFor(
  provider: FastModeCatalogProvider | undefined,
  slug: string,
): ReadonlyArray<ProviderOptionDescriptor> {
  return (
    provider?.models.find((model) => model.slug === slug)?.capabilities?.optionDescriptors ?? []
  );
}

/**
 * Turn a resolved model selection into that provider's fast variant.
 * Returns the same selection when the catalog has no fast control, so callers
 * can tell a miss from a change by reference.
 */
export function applyFastModeSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<FastModeCatalogProvider>,
): ModelSelection {
  const provider = providers.find((entry) => entry.instanceId === selection.instanceId);
  const descriptors = descriptorsFor(provider, selection.model);
  if (
    descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode")
  ) {
    return withOption(selection, { id: "fastMode", value: true });
  }
  const serviceTier = descriptors.find(
    (descriptor) => descriptor.type === "select" && descriptor.id === "serviceTier",
  );
  if (
    serviceTier?.type === "select" &&
    serviceTier.options.some((choice) => choice.id === "fast")
  ) {
    return withOption(selection, { id: "serviceTier", value: "fast" });
  }
  if (provider?.driver === "grok") {
    if (selection.model.endsWith(GROK_FAST_MODEL_SUFFIX) || selection.model.endsWith("-fast")) {
      // Already the fast slug. A new object so callers do not treat this as a miss.
      return { ...selection };
    }
    const fastSlug = `${selection.model}${GROK_FAST_MODEL_SUFFIX}`;
    if (provider.models.some((model) => model.slug === fastSlug)) {
      return { ...selection, model: fastSlug };
    }
    return selection;
  }
  // Codex maps `fastMode: true` onto service tier "fast". Claude and Cursor
  // read the same boolean. A snapshot that omitted descriptors still honors it.
  if (
    provider?.driver === "codex" ||
    provider?.driver === "claudeAgent" ||
    provider?.driver === "cursor"
  ) {
    return withOption(selection, { id: "fastMode", value: true });
  }
  return selection;
}
