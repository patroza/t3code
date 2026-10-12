// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import type { ModelSelection, ServerProvider } from "@t3tools/contracts";

export { resolveGitHubUrlForWorkspace } from "./githubLinks.ts";

export const CHANNEL_INFO_PIN_MARKER = "Omegent Channel Info";

/**
 * Markers the bot used before the Omegent rebrand. Pin detection matches these too so
 * an existing pre-rebrand pin is found and rewritten in place instead of orphaned
 * alongside a fresh one.
 */
export const LEGACY_CHANNEL_INFO_PIN_MARKERS = ["T3 Bot Channel Info"] as const;

/** Discord hard limit for message content (pins use the same limit). */
export const DISCORD_MESSAGE_CONTENT_LIMIT = 2000;

function formatProviderLabel(provider: Pick<ServerProvider, "instanceId">): string {
  return provider.instanceId;
}

function providerStatusSuffix(
  provider: Pick<ServerProvider, "enabled" | "installed" | "availability" | "status">,
): string {
  if (!provider.installed) return " [missing]";
  if (!provider.enabled) return " [off]";
  if (provider.availability === "unavailable") return " [down]";
  if (provider.status === "disabled") return " [off]";
  return "";
}

function shortenModelSlug(slug: string): string {
  const trimmed = slug.trim();
  if (trimmed.length === 0) return trimmed;
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

const COMPAT_MODEL_PREFIX = /^(?:claude|codex)-/iu;

/**
 * Name to show and accept for `--model`. Prefer a versioned short alias
 * (`opus-5.5`) over the catalog slug. `claude-` and `codex-` prefixes stay
 * resolvable, but the pin documents the short form.
 */
export function discordModelLabel(model: {
  readonly slug: string;
  readonly shortName?: string | undefined;
  readonly aliases?: ReadonlyArray<string> | undefined;
}): string {
  const shortAliases = (model.aliases ?? [])
    .map((alias) => alias.trim())
    .filter((alias) => alias.length > 0 && !COMPAT_MODEL_PREFIX.test(alias));
  const versioned = shortAliases
    .filter((alias) => /\d/u.test(alias))
    .toSorted((left, right) => right.length - left.length);
  const preferred = versioned[0] ?? shortAliases[0];
  if (preferred !== undefined) return preferred;
  const leaf = shortenModelSlug(model.slug);
  const stripped = leaf.replace(COMPAT_MODEL_PREFIX, "");
  return stripped.length > 0 ? stripped : leaf;
}

/** Reply when `--model` matches nothing. Include the pin link when we have one. */
export function formatUnknownDiscordModelMessage(input: {
  readonly requestedModel: string;
  readonly channelInfoUrl: string | null;
}): string {
  const where =
    input.channelInfoUrl === null
      ? "the pinned channel info message in this channel"
      : `the pinned channel info: ${input.channelInfoUrl}`;
  return `Unknown model \`${input.requestedModel}\`. See ${where}.`;
}

function wrapItems(
  prefix: string,
  items: ReadonlyArray<string>,
  maxWidth: number,
): ReadonlyArray<string> {
  if (items.length === 0) return [`${prefix}(none)`];

  const lines: string[] = [];
  let current = prefix;

  for (const item of items) {
    const separator = current === prefix ? "" : ", ";
    const next = `${current}${separator}${item}`;
    if (current !== prefix && next.length > maxWidth) {
      lines.push(current);
      current = `${" ".repeat(prefix.length)}${item}`;
      continue;
    }
    current = next;
  }

  lines.push(current);
  return lines;
}

function renderProviderLines(
  providers: ReadonlyArray<
    Pick<
      ServerProvider,
      "instanceId" | "models" | "enabled" | "installed" | "availability" | "status"
    >
  >,
  options?: { readonly maxModelsPerProvider?: number },
): ReadonlyArray<string> {
  if (providers.length === 0) return ["(no configured providers expose models)"];

  const maxModels = options?.maxModelsPerProvider;
  const labels = providers.map(
    (provider) => `${formatProviderLabel(provider)}${providerStatusSuffix(provider)}`,
  );
  const labelWidth = labels.reduce((max, label) => Math.max(max, label.length), 0);

  return providers.flatMap((provider, index) => {
    const label = labels[index]!.padEnd(labelWidth, " ");
    const allModels = provider.models.map((model) => discordModelLabel(model));
    const models =
      maxModels === undefined || allModels.length <= maxModels
        ? allModels
        : [...allModels.slice(0, maxModels), `+${allModels.length - maxModels} more`];
    return wrapItems(`${label}  `, models, 110);
  });
}

function buildChannelInfoPinBody(input: {
  readonly githubUrl: string | null;
  readonly workspaceRoot: string;
  readonly providers: ReadonlyArray<
    Pick<
      ServerProvider,
      "instanceId" | "models" | "enabled" | "installed" | "availability" | "status"
    >
  >;
  readonly defaultModelSelection: ModelSelection | null;
  readonly maxModelsPerProvider?: number;
}): string {
  const repoDirectory = NodePath.resolve(input.workspaceRoot);
  const githubLine = input.githubUrl ?? "(unable to resolve origin GitHub URL)";
  const providerLines = renderProviderLines(
    input.providers,
    input.maxModelsPerProvider === undefined
      ? {}
      : { maxModelsPerProvider: input.maxModelsPerProvider },
  );
  const defaultModel = input.providers
    .find((provider) => provider.instanceId === input.defaultModelSelection?.instanceId)
    ?.models.find((model) => model.slug === input.defaultModelSelection?.model);
  const defaultLine =
    input.defaultModelSelection === null
      ? "(unable to resolve)"
      : `${input.defaultModelSelection.instanceId}/${
          defaultModel === undefined
            ? input.defaultModelSelection.model
            : discordModelLabel(defaultModel)
        }`;

  // Keep the command block compact — every line counts against Discord's 2000 limit.
  // Prefer /omegent slash commands (/agent is an alias); @Omegent mentions are a fallback.
  return [
    `**${CHANNEL_INFO_PIN_MARKER}**`,
    "",
    `GitHub: ${githubLine}`,
    "",
    "Repository directory:",
    "```text",
    repoDirectory,
    "```",
    "Bot commands (prefer **/omegent**, alias **/agent**):",
    "```text",
    "/omegent ask prompt:…           Start or continue work",
    "  options: model provider base local plan steer queue",
    "/omegent today-recap            Daily PR recap for this channel's repo",
    "/omegent steer prompt:…         Mid-turn: inject now",
    "/omegent queue prompt:…         Mid-turn: park (same as default)",
    "/omegent steernow               Inject the whole parked queue",
    "/omegent help                   This pin",
    "/omegent stop                   Stop active turn",
    "/omegent compact                Compact context (posts token stats)",
    "/omegent thread-talk action:on|off|status",
    "/omegent link ref:<id|url>",
    "/omegent refresh-indicators",
    "/omegent assign [github:login]  Assign linked PR(s) (default: you)",
    "@Omegent …                      Same actions (fallback)",
    "  flags: --plan --local --base <b> --provider <id> --model <name>",
    "         —model works too. Short names (opus-5.5).",
    "         claude- and codex- prefixes still work.",
    "         --steer (inject now) --queue (park; default mid-turn)",
    "  queued: 📥 badge · delete your message to cancel · /steernow to flush",
    "```",
    `Default provider/model: \`${defaultLine}\``,
    "Supported provider/model configurations:",
    "```text",
    ...providerLines,
    "```",
  ].join("\n");
}

/**
 * Render the channel-info pin body, always ≤ Discord's message content limit.
 * Provider model lists are truncated first; hard-truncation is a last resort.
 */
export function renderChannelInfoPin(input: {
  readonly githubUrl: string | null;
  readonly workspaceRoot: string;
  readonly providers: ReadonlyArray<
    Pick<
      ServerProvider,
      "instanceId" | "models" | "enabled" | "installed" | "availability" | "status"
    >
  >;
  readonly defaultModelSelection: ModelSelection | null;
  readonly maxLength?: number;
}): string {
  const maxLength = input.maxLength ?? DISCORD_MESSAGE_CONTENT_LIMIT;
  const modelCaps = [undefined, 12, 6, 3, 1] as const;

  for (const maxModelsPerProvider of modelCaps) {
    const rendered = buildChannelInfoPinBody({
      githubUrl: input.githubUrl,
      workspaceRoot: input.workspaceRoot,
      providers: input.providers,
      defaultModelSelection: input.defaultModelSelection,
      ...(maxModelsPerProvider === undefined ? {} : { maxModelsPerProvider }),
    });
    if (rendered.length <= maxLength) return rendered;
  }

  // Last resort: keep the header/commands and drop the provider dump.
  const header = buildChannelInfoPinBody({
    githubUrl: input.githubUrl,
    workspaceRoot: input.workspaceRoot,
    providers: [],
    defaultModelSelection: input.defaultModelSelection,
  });
  const withoutProviders = header.replace(
    "Supported provider/model configurations:\n```text\n(no configured providers expose models)\n```",
    "Supported provider/model configurations: _(truncated — too many models for a Discord pin)_",
  );

  if (withoutProviders.length <= maxLength) return withoutProviders;

  const ellipsis = "…";
  return `${withoutProviders.slice(0, Math.max(0, maxLength - ellipsis.length))}${ellipsis}`;
}
