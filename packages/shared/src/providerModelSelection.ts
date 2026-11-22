import { type ModelSelection, type ProviderInstanceId } from "@t3tools/contracts";

export interface ParsedProviderModelFlags {
  readonly provider?: string;
  readonly model?: string;
  readonly discord: boolean;
  readonly prompt: string;
}

export const DISCORD_LINK_REQUEST_MARKER = "T3 Discord link requested from GitHub: yes";

export function parseProviderModelFlags(raw: string): ParsedProviderModelFlags {
  const tokens = raw
    .trim()
    .split(/\s+/u)
    .filter((token) => token.length > 0);
  let provider: string | undefined;
  let model: string | undefined;
  let discord = false;
  const promptParts: string[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--discord") {
      discord = true;
      continue;
    }
    if (token === "--provider" || token === "--model") {
      const value = tokens[index + 1];
      if (value !== undefined && !value.startsWith("--")) {
        if (token === "--provider") provider = value;
        else model = value;
        index += 1;
        continue;
      }
    }
    promptParts.push(token);
  }

  return {
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    discord,
    prompt: promptParts.join(" ").trim(),
  };
}

export interface ProviderModelCatalogEntry {
  readonly instanceId: ProviderInstanceId;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly name: string;
    readonly shortName?: string | undefined;
    readonly aliases?: ReadonlyArray<string> | undefined;
  }>;
}

function modelHaystack(model: ProviderModelCatalogEntry["models"][number]): string {
  return `${model.slug} ${model.name} ${model.shortName ?? ""}`.toLowerCase();
}

/**
 * Compare model queries independent of a `claude-` / `codex-` prefix and of
 * `.` vs `-` in versions. `opus-5.5`, `opus-5-5`, and `claude-opus-5.5` all
 * share the key `opus-5-5`. Prefixed names stay valid; they are not required.
 */
function canonicalModelKey(value: string): string {
  const normalized = value.trim().toLowerCase().replaceAll(/[._]/gu, "-");
  return normalized.replace(/^(?:claude|codex)-/u, "");
}

function isCanonicalModelMatch(
  model: ProviderModelCatalogEntry["models"][number],
  desired: string,
): boolean {
  const needle = canonicalModelKey(desired);
  if (needle.length === 0) return false;
  const candidates = [model.slug, model.name, model.shortName, ...(model.aliases ?? [])];
  return candidates.some(
    (candidate) => candidate !== undefined && canonicalModelKey(candidate) === needle,
  );
}

/**
 * Guess the native driver for a model query so multi-provider catalogs
 * (e.g. Cursor + Claude both listing Opus) pick the first-party provider.
 */
function nativeDriverHint(desired: string): string | undefined {
  const needle = desired.toLowerCase();
  if (needle.includes("grok")) return "grok";
  if (needle.includes("kimi")) return "kimi";
  if (needle.includes("composer") || needle === "auto") return "cursor";
  if (
    needle.includes("claude") ||
    needle.includes("opus") ||
    needle.includes("sonnet") ||
    needle.includes("haiku")
  ) {
    return "claudeAgent";
  }
  if (needle.includes("gpt") || needle.includes("codex") || /^5\.\d/.test(needle)) {
    return "codex";
  }
  return undefined;
}

type CatalogModelMatch = {
  readonly provider: ProviderModelCatalogEntry;
  readonly slug: string;
  readonly exactSlug: boolean;
  readonly catalogIndex: number;
};

/** Match a model on one provider without falling back to that provider's default. */
function matchModelOnProvider(
  provider: ProviderModelCatalogEntry,
  desired: string,
  catalogIndex: number,
): CatalogModelMatch | undefined {
  if (provider.models.length === 0) return undefined;
  const needle = desired.toLowerCase().trim();
  if (needle === "") return undefined;

  const canonical = provider.models.find((model) => isCanonicalModelMatch(model, desired));
  if (canonical !== undefined) {
    return { provider, slug: canonical.slug, exactSlug: true, catalogIndex };
  }

  const fuzzy = provider.models.find((model) => modelHaystack(model).includes(needle));
  if (fuzzy !== undefined) {
    return { provider, slug: fuzzy.slug, exactSlug: false, catalogIndex };
  }

  return undefined;
}

/**
 * When only a model is requested, pick the best provider that catalogs it.
 * Prefers sticky/preferred provider (same-provider switches), then exact slug,
 * then native driver for the model name, then default instance id.
 */
function resolveModelOnlySelection(input: {
  readonly available: ReadonlyArray<ProviderModelCatalogEntry>;
  readonly desiredModel: string;
  readonly preferredInstanceId: string;
}): ModelSelection | undefined {
  const matches: CatalogModelMatch[] = [];
  for (let index = 0; index < input.available.length; index += 1) {
    const provider = input.available[index]!;
    const match = matchModelOnProvider(provider, input.desiredModel, index);
    if (match !== undefined) matches.push(match);
  }
  if (matches.length === 0) return undefined;

  const preferredInstanceId = input.preferredInstanceId;
  const preferredDriver =
    input.available.find((provider) => provider.instanceId === preferredInstanceId)?.driver ??
    input.available.find((provider) => provider.driver === preferredInstanceId)?.driver;
  const nativeDriver = nativeDriverHint(input.desiredModel);

  const rank = (match: CatalogModelMatch): number => {
    const isPreferredInstance =
      match.provider.instanceId === preferredInstanceId ||
      match.provider.driver === preferredInstanceId;
    const isPreferredDriver =
      preferredDriver !== undefined && match.provider.driver === preferredDriver;
    const isNativeDriver = nativeDriver !== undefined && match.provider.driver === nativeDriver;
    const isDefaultInstance = match.provider.instanceId === match.provider.driver;

    // Lower is better. An exact catalog match (slug, alias, short name, or the
    // same name with the claude-/codex- prefix and ./- spelling ignored) beats
    // a fuzzy match on any provider, including the sticky one. Among exact
    // matches, the sticky provider still wins.
    let score = 0;
    if (!match.exactSlug) score += 10_000;
    if (!isPreferredInstance) score += 1_000;
    if (!isNativeDriver) score += 40;
    if (!isPreferredDriver) score += 20;
    if (!isDefaultInstance) score += 10;
    score += match.catalogIndex;
    return score;
  };

  matches.sort((left, right) => rank(left) - rank(right));
  const best = matches[0]!;
  return { instanceId: best.provider.instanceId, model: best.slug };
}

function resolveModelSlug(
  provider: ProviderModelCatalogEntry,
  desired: string | undefined,
): string | undefined {
  if (provider.models.length === 0) return undefined;
  if (desired !== undefined && desired.trim() !== "") {
    const match = matchModelOnProvider(provider, desired, 0);
    if (match !== undefined) return match.slug;
  }
  return (
    provider.models.find((model) => !model.slug.includes("custom"))?.slug ??
    provider.models[0]?.slug
  );
}

export interface ResolveProviderModelSelectionInput {
  readonly providers: ReadonlyArray<ProviderModelCatalogEntry>;
  readonly projectDefault?: ModelSelection | null;
  readonly preferredSelection?: ModelSelection | null;
  readonly fallbackSelection: ModelSelection;
  readonly overrideInstanceId?: string;
  readonly overrideModel?: string;
  /**
   * When an explicit model matches nothing in the catalog, return null instead
   * of the default model. Discord uses this so a typo does not start a turn.
   */
  readonly rejectUnknownOverride?: boolean;
}

export function resolveProviderModelSelection(
  input: ResolveProviderModelSelectionInput & { readonly rejectUnknownOverride: true },
): ModelSelection | null;
export function resolveProviderModelSelection(
  input: ResolveProviderModelSelectionInput,
): ModelSelection;
export function resolveProviderModelSelection(
  input: ResolveProviderModelSelectionInput,
): ModelSelection | null {
  const available = input.providers.filter(
    (provider) => provider.enabled && provider.installed && provider.models.length > 0,
  );

  if (input.overrideInstanceId !== undefined && input.overrideModel !== undefined) {
    const provider =
      available.find((entry) => entry.instanceId === input.overrideInstanceId) ??
      available.find((entry) => entry.driver === input.overrideInstanceId);
    const match =
      provider === undefined ? undefined : matchModelOnProvider(provider, input.overrideModel, 0);
    if (match !== undefined) {
      return { instanceId: match.provider.instanceId, model: match.slug };
    }
    if (input.rejectUnknownOverride === true) return null;
    return {
      instanceId: input.overrideInstanceId as ProviderInstanceId,
      model: input.overrideModel,
    };
  }

  const desiredInstance =
    input.overrideInstanceId ??
    input.preferredSelection?.instanceId ??
    input.fallbackSelection.instanceId;
  const desiredModel =
    input.overrideModel ?? input.preferredSelection?.model ?? input.fallbackSelection.model;

  // Model-only override: match the model to a cataloged provider instead of
  // forcing the sticky/default provider (e.g. gpt-5.6 must not run on Grok).
  if (input.overrideModel !== undefined && input.overrideInstanceId === undefined) {
    const modelOnly = resolveModelOnlySelection({
      available,
      desiredModel: input.overrideModel,
      preferredInstanceId: desiredInstance,
    });
    if (modelOnly !== undefined) return modelOnly;
    if (input.rejectUnknownOverride === true) return null;
  }

  const preferredProvider =
    available.find((provider) => provider.instanceId === desiredInstance) ??
    available.find((provider) => provider.driver === desiredInstance);
  if (preferredProvider !== undefined) {
    const model = resolveModelSlug(preferredProvider, desiredModel);
    if (model !== undefined) return { instanceId: preferredProvider.instanceId, model };
  }

  if (input.projectDefault !== null && input.projectDefault !== undefined) {
    const projectProvider = available.find(
      (provider) => provider.instanceId === input.projectDefault!.instanceId,
    );
    if (projectProvider !== undefined) {
      return {
        instanceId: projectProvider.instanceId,
        model:
          resolveModelSlug(projectProvider, input.projectDefault.model) ??
          input.projectDefault.model,
      };
    }
  }

  const fallbackProvider = available[0];
  if (fallbackProvider === undefined) return input.fallbackSelection;
  return {
    instanceId: fallbackProvider.instanceId,
    model: resolveModelSlug(fallbackProvider, desiredModel) ?? fallbackProvider.models[0]!.slug,
  };
}
