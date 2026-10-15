import { it as effectIt } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { preferredModelSelection, DiscordBotConfig } from "./config.ts";
import { pickT3ThreadUrlForGithubRepo } from "./presentation/discordPrAttribution.ts";

describe("tenant web URL configuration", () => {
  effectIt.effect("uses the configured public origin when selecting a public PR link", () =>
    Effect.gen(function* () {
      const config = yield* DiscordBotConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({
            T3_WEB_UI_BASE_URL: "https://private.example.test",
            T3_WEB_UI_PUBLIC_BASE_URL: "https://public.example.test",
          }),
        ),
      );
      expect(
        pickT3ThreadUrlForGithubRepo({
          fullUrl: `${config.webUiBaseUrl}/?thread=t1`,
          repoIsPrivate: false,
          publicBaseUrl: config.publicWebUiBaseUrl,
        }),
      ).toBe("https://public.example.test/?thread=t1");
    }),
  );
});

const baseConfig = {
  discordToken: "x",
  t3HttpBaseUrl: "http://127.0.0.1:8080",
  t3BootstrapCredential: undefined,
  t3BearerToken: undefined,
  t3DefaultInstanceId: "codex",
  t3DefaultModel: "gpt-5.4",
  t3DefaultBaseBranch: "main",
  t3DefaultRuntimeMode: "full-access" as const,
  dataDir: "~/.t3/discord-bot",
  webUiBaseUrl: undefined,
  projectAliasesPath: undefined,
  identityMapPath: undefined,
  honeycombTraceUrlTemplate: undefined,
  alertsChannelId: undefined,
  alertProcessRulesPath: undefined,
  stateSqlitePath: "/var/lib/t3/userdata/state.sqlite",
  browserEnabled: false,
  browserProfile: "default",
  browserExecutablePath: undefined,
  browserFfmpegPath: "ffmpeg",
  browserAllowedOrigins: [],
  jiraBrowseBaseUrl: "https://example.atlassian.net",
  teamsEnabled: false,
  teamsTenantId: undefined,
  teamsClientId: undefined,
  teamsClientSecret: undefined,
  teamsChannelsPath: undefined,
  teamsPollIntervalSeconds: 60,
  teamsBotDisplayName: undefined,
  teamsNativeEnabled: false,
  teamsPort: 3978,
  teamsMessagingEndpoint: "/api/messages" as const,
  teamsDefaultProjectShortName: undefined,
} satisfies DiscordBotConfig;

describe("preferredModelSelection", () => {
  const claudeConfig = {
    ...baseConfig,
    t3DefaultInstanceId: "claudeAgent",
    t3DefaultModel: "claude-opus-5-5",
  };

  it("does not select the offline Codex fallback before provider discovery", () => {
    expect(preferredModelSelection({ config: claudeConfig, providers: [] })).toBeNull();
  });

  it.each([
    { enabled: false, installed: true, models: [{ slug: "gpt-6-astra", name: "GPT" }] },
    { enabled: true, installed: false, models: [{ slug: "gpt-6-astra", name: "GPT" }] },
    { enabled: true, installed: true, models: [] },
  ])("does not create a thread when every provider is unavailable: %j", (state) => {
    expect(
      preferredModelSelection({
        config: claudeConfig,
        providers: [{ instanceId: ProviderInstanceId.make("codex"), driver: "codex", ...state }],
      }),
    ).toBeNull();
  });

  it("uses Claude when it becomes ready while Codex remains disabled", () => {
    expect(
      preferredModelSelection({
        config: claudeConfig,
        providers: [
          {
            instanceId: ProviderInstanceId.make("codex"),
            driver: "codex",
            enabled: false,
            installed: true,
            models: [{ slug: "gpt-6-astra", name: "GPT" }],
          },
          {
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: "claudeAgent",
            enabled: true,
            installed: true,
            models: [{ slug: "claude-opus-5-5", name: "Opus" }],
          },
        ],
      }),
    ).toEqual({ instanceId: "claudeAgent", model: "claude-opus-5-5" });
  });

  it("uses the project default before the bot fallback", () => {
    const selection = preferredModelSelection({
      config: baseConfig,
      projectDefault: {
        instanceId: ProviderInstanceId.make("grok"),
        model: "grok-build",
      },
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          installed: true,
          models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
        },
        {
          instanceId: ProviderInstanceId.make("grok"),
          driver: "grok",
          enabled: true,
          installed: true,
          models: [{ slug: "grok-build", name: "Grok Build" }],
        },
      ],
    });

    expect(selection).toEqual({
      instanceId: "grok",
      model: "grok-build",
    });
  });

  it("honors explicit mention overrides", () => {
    const selection = preferredModelSelection({
      config: baseConfig,
      overrideInstanceId: "cursor",
      overrideModel: "composer-2",
      providers: [
        {
          instanceId: ProviderInstanceId.make("cursor"),
          driver: "cursor",
          enabled: true,
          installed: true,
          models: [{ slug: "composer-2", name: "Composer 2" }],
        },
      ],
    });

    expect(selection).toEqual({
      instanceId: "cursor",
      model: "composer-2",
    });
  });

  it("uses the current thread provider as the sticky base for model-only overrides", () => {
    const selection = preferredModelSelection({
      config: baseConfig,
      stickyModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
      },
      overrideModel: "claude-opus-4-6",
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          installed: true,
          models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
        },
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          models: [
            { slug: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
            { slug: "claude-opus-4-6", name: "Claude Opus 4.6" },
          ],
        },
      ],
    });

    expect(selection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-4-6",
    });
  });

  it("matches model-only overrides to the native provider instead of sticky default", () => {
    const selection = preferredModelSelection({
      config: {
        ...baseConfig,
        t3DefaultInstanceId: "grok",
        t3DefaultModel: "grok-build",
      },
      stickyModelSelection: {
        instanceId: ProviderInstanceId.make("grok"),
        model: "grok-build",
      },
      overrideModel: "gpt-5.6",
      providers: [
        {
          instanceId: ProviderInstanceId.make("grok"),
          driver: "grok",
          enabled: true,
          installed: true,
          models: [{ slug: "grok-build", name: "Grok Build" }],
        },
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          installed: true,
          models: [
            { slug: "gpt-5.4", name: "GPT-5.4" },
            { slug: "gpt-5.6", name: "GPT-5.6" },
          ],
        },
      ],
    });

    expect(selection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6",
    });
  });

  it("resolves a short model name to the catalog slug", () => {
    const selection = preferredModelSelection({
      config: baseConfig,
      overrideModel: "opus-5.5",
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          installed: true,
          models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
        },
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driver: "claudeAgent",
          enabled: true,
          installed: true,
          models: [
            {
              slug: "claude-opus-5-5",
              name: "Claude Opus 5.5",
              aliases: ["opus", "opus-5.5", "claude-opus-5.5"],
            },
          ],
        },
      ],
    });

    expect(selection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });

  it("returns null when an explicit model matches nothing", () => {
    const selection = preferredModelSelection({
      config: baseConfig,
      overrideModel: "opus-9",
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          installed: true,
          models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
        },
      ],
    });

    expect(selection).toBeNull();
  });

  it("keeps the current thread model as the sticky default when only the provider override changes", () => {
    const selection = preferredModelSelection({
      config: baseConfig,
      stickyModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      overrideInstanceId: "codex_work",
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          enabled: true,
          installed: true,
          models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
        },
        {
          instanceId: ProviderInstanceId.make("codex_work"),
          driver: "codex",
          enabled: true,
          installed: true,
          models: [{ slug: "gpt-5.4", name: "GPT-5.4" }],
        },
      ],
    });

    expect(selection).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.4",
    });
  });
});
