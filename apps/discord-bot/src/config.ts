import {
  DEFAULT_MODEL,
  type ModelSelection,
  type ProviderInstanceId,
  type RuntimeMode,
} from "@t3tools/contracts";
import { resolveProviderModelSelection } from "@t3tools/shared/providerModelSelection";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

export interface DiscordBotConfig {
  readonly discordToken: string;
  readonly t3HttpBaseUrl: string;
  readonly t3BootstrapCredential: string | undefined;
  readonly t3BearerToken: string | undefined;
  readonly t3DefaultInstanceId: string | undefined;
  readonly t3DefaultModel: string | undefined;
  readonly t3DefaultBaseBranch: string;
  readonly t3DefaultRuntimeMode: RuntimeMode;
  readonly dataDir: string;
  readonly webUiBaseUrl: string | undefined;
  /** Bot-local shortName → workspaceRoot map (not on the T3 server). */
  readonly projectAliasesPath: string | undefined;
  /**
   * Optional Honeycomb trace URL template for bootstrap prompts.
   * Placeholders: {traceId}, {environment}, {dataset}, {team}
   */
  readonly honeycombTraceUrlTemplate: string | undefined;
  /**
   * Discord channel id for guest ops alerts (load, mem, runaway MCP, long turns).
   * Unset → watchdog does not post.
   */
  readonly alertsChannelId: string | undefined;
  /**
   * Path to t3code `state.sqlite` for long-turn detection (guest: /var/lib/t3/userdata/state.sqlite).
   */
  readonly stateSqlitePath: string;
  readonly browserEnabled: boolean;
  readonly browserProfile: string;
  readonly browserExecutablePath: string | undefined;
  readonly browserFfmpegPath: string;
  readonly browserAllowedOrigins: ReadonlyArray<string>;
  /**
   * Optional Jira site base for browse links on pinned thread-info messages
   * (e.g. `https://example.atlassian.net`).
   */
  readonly jiraBrowseBaseUrl: string | undefined;
}

const RuntimeModeConfig = Schema.Literals([
  "full-access",
  "auto-accept-edits",
  "approval-required",
]);

/** Match T3 Code web defaults (Codex / GPT-5.4). */
const DEFAULT_BOT_INSTANCE_ID = "codex";
const DEFAULT_BOT_MODEL = DEFAULT_MODEL;

export const DiscordBotConfig: Effect.Effect<DiscordBotConfig, Config.ConfigError> = Effect.gen(
  function* () {
    const discordToken = yield* Config.redacted("DISCORD_BOT_TOKEN").pipe(
      Config.map((value) => Redacted.value(value)),
    );
    const t3HttpBaseUrl = yield* Config.string("T3_HTTP_BASE_URL").pipe(
      Config.withDefault("http://127.0.0.1:3773"),
    );
    const t3BootstrapCredential = yield* Config.string("T3_BOOTSTRAP_CREDENTIAL").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const t3BearerToken = yield* Config.string("T3_BEARER_TOKEN").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    // Align with T3 web default unless operator pins another instance/model.
    const t3DefaultInstanceId = yield* Config.string("T3_DEFAULT_INSTANCE_ID").pipe(
      Config.withDefault(DEFAULT_BOT_INSTANCE_ID),
    );
    const t3DefaultModel = yield* Config.string("T3_DEFAULT_MODEL").pipe(
      Config.withDefault(DEFAULT_BOT_MODEL),
    );
    const t3DefaultBaseBranch = yield* Config.string("T3_DEFAULT_BASE_BRANCH").pipe(
      Config.withDefault("main"),
    );
    const t3DefaultRuntimeMode = yield* Config.schema(
      RuntimeModeConfig,
      "T3_DEFAULT_RUNTIME_MODE",
    ).pipe(Config.withDefault("full-access" as const));
    const dataDir = yield* Config.string("T3_DISCORD_BOT_DATA_DIR").pipe(
      Config.withDefault("~/.t3/discord-bot"),
    );
    const webUiBaseUrl = yield* Config.string("T3_WEB_UI_BASE_URL").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const projectAliasesPath = yield* Config.string("T3_PROJECT_ALIASES_PATH").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const honeycombTraceUrlTemplate = yield* Config.string("T3_HONEYCOMB_TRACE_URL_TEMPLATE").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const alertsChannelId = yield* Config.string("DISCORD_ALERTS_CHANNEL_ID").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const stateSqlitePath = yield* Config.string("T3_STATE_SQLITE_PATH").pipe(
      Config.withDefault("/var/lib/t3/userdata/state.sqlite"),
    );
    const browserEnabled = yield* Config.boolean("T3_DISCORD_BROWSER_ENABLED").pipe(
      Config.withDefault(false),
    );
    const browserProfile = yield* Config.string("T3_DISCORD_BROWSER_PROFILE").pipe(
      Config.withDefault("default"),
    );
    const browserExecutablePath = yield* Config.string("T3_DISCORD_BROWSER_EXECUTABLE_PATH").pipe(
      Config.option,
      Config.map(Option.getOrUndefined),
    );
    const browserFfmpegPath = yield* Config.string("T3_DISCORD_BROWSER_FFMPEG_PATH").pipe(
      Config.withDefault("ffmpeg"),
    );
    const browserAllowedOrigins = yield* Config.string("T3_DISCORD_BROWSER_ALLOWED_ORIGINS").pipe(
      Config.withDefault(""),
      Config.map((value) =>
        value
          .split(",")
          .map((origin) => origin.trim())
          .filter(Boolean),
      ),
    );
    const jiraBrowseBaseUrl = yield* Config.string("T3_JIRA_BROWSE_BASE_URL").pipe(
      Config.orElse(() => Config.string("JIRA_BROWSE_BASE_URL")),
      Config.option,
      Config.map((value) => {
        const raw = Option.getOrUndefined(value);
        if (raw === undefined) return undefined;
        const trimmed = raw.trim().replace(/\/+$/u, "");
        if (trimmed.length === 0) return undefined;
        const site = trimmed.match(/^(https?:\/\/[a-z0-9.-]+\.atlassian\.net)(?:\/.*)?$/iu);
        if (site?.[1] !== undefined) return site[1];
        if (/^https?:\/\//iu.test(trimmed) && !trimmed.includes("/ex/jira/")) return trimmed;
        return undefined;
      }),
    );

    return {
      discordToken,
      t3HttpBaseUrl,
      t3BootstrapCredential,
      t3BearerToken,
      t3DefaultInstanceId,
      t3DefaultModel,
      t3DefaultBaseBranch,
      t3DefaultRuntimeMode,
      dataDir,
      webUiBaseUrl,
      projectAliasesPath,
      honeycombTraceUrlTemplate,
      alertsChannelId,
      stateSqlitePath,
      browserEnabled,
      browserProfile,
      browserExecutablePath,
      browserFfmpegPath,
      browserAllowedOrigins,
      jiraBrowseBaseUrl,
    } satisfies DiscordBotConfig;
  },
);

/**
 * Discord bot model selection (conservative defaults):
 * 1. Explicit mention overrides (`--provider` / `--model`)
 *    - Model-only (`--model` without `--provider`) picks the best cataloged
 *      native provider for that model (e.g. gpt-5.6 → codex, not sticky Grok)
 *    - Sticky/current provider still wins when it catalogs the requested model
 * 2. Bot env defaults (default: codex + gpt-5.4, same as T3 web)
 * 3. Project defaultModelSelection if that provider is available
 * 4. First enabled installed provider
 *
 * Note: Grok Build previously hit provider turn-start decode failures for large
 * Discord bootstrap prompts; prefer Codex unless the operator pins Grok/Composer.
 */
export function preferredModelSelection(input: {
  readonly config: DiscordBotConfig;
  readonly providers: Parameters<typeof resolveProviderModelSelection>[0]["providers"];
  readonly projectDefault?: ModelSelection | null;
  readonly stickyModelSelection?: ModelSelection | null;
  readonly overrideInstanceId?: string;
  readonly overrideModel?: string;
}): ModelSelection {
  const fallbackSelection = {
    instanceId: DEFAULT_BOT_INSTANCE_ID as ProviderInstanceId,
    model: DEFAULT_BOT_MODEL,
  };
  const preferredSelection = input.stickyModelSelection ?? {
    instanceId: (input.config.t3DefaultInstanceId ?? DEFAULT_BOT_INSTANCE_ID) as ProviderInstanceId,
    model: input.config.t3DefaultModel ?? DEFAULT_BOT_MODEL,
  };
  return resolveProviderModelSelection({
    providers: input.providers,
    ...(input.projectDefault === undefined ? {} : { projectDefault: input.projectDefault }),
    preferredSelection,
    fallbackSelection,
    ...(input.overrideInstanceId === undefined
      ? {}
      : { overrideInstanceId: input.overrideInstanceId }),
    ...(input.overrideModel === undefined ? {} : { overrideModel: input.overrideModel }),
  });
}
