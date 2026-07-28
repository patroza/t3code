import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { preferredModelSelection, type DiscordBotConfig } from "./config.ts";

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
} satisfies DiscordBotConfig;

describe("preferredModelSelection", () => {
  it("defaults to codex gpt-5.4 over project grok", () => {
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

    expect(selection.instanceId).toBe("codex");
    expect(selection.model).toBe("gpt-5.4");
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
