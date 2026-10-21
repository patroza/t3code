import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CHANNEL_INFO_PIN_MARKER,
  DISCORD_MESSAGE_CONTENT_LIMIT,
  discordModelLabel,
  formatUnknownDiscordModelMessage,
  renderChannelInfoPin,
} from "./channelInfoPin.ts";
import { normalizeGitHubRemoteUrl } from "./githubLinks.ts";

describe("channel info pin helpers", () => {
  it("normalizes GitHub SSH remotes", () => {
    expect(normalizeGitHubRemoteUrl("git@github.com:pingdotgg/t3code.git")).toBe(
      "https://github.com/pingdotgg/t3code",
    );
    expect(normalizeGitHubRemoteUrl("ssh://git@github.com/pingdotgg/t3code.git")).toBe(
      "https://github.com/pingdotgg/t3code",
    );
  });

  it("normalizes GitHub HTTPS remotes", () => {
    expect(normalizeGitHubRemoteUrl("https://github.com/pingdotgg/t3code.git")).toBe(
      "https://github.com/pingdotgg/t3code",
    );
  });

  it("rejects non-GitHub remotes", () => {
    expect(normalizeGitHubRemoteUrl("https://gitlab.com/pingdotgg/t3code.git")).toBeNull();
  });

  it("renders a fallback when the origin GitHub URL cannot be resolved", () => {
    const rendered = renderChannelInfoPin({
      githubUrl: null,
      workspaceRoot: "/tmp/t3code",
      providers: [],
      defaultModelSelection: null,
    });

    expect(rendered).toContain("GitHub: (unable to resolve origin GitHub URL)");
    expect(rendered).not.toContain("origin remote is not a GitHub repository");
  });

  it("renders a stable pinned help message", () => {
    const rendered = renderChannelInfoPin({
      githubUrl: "https://github.com/pingdotgg/t3code",
      workspaceRoot: "/tmp/t3code",
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          models: [
            { slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null },
            { slug: "gpt-5.5", name: "GPT-5.5", isCustom: false, capabilities: null },
          ],
        },
        {
          instanceId: ProviderInstanceId.make("grok"),
          enabled: true,
          installed: false,
          status: "disabled",
          availability: "unavailable",
          models: [{ slug: "grok-build", name: "Grok Build", isCustom: false, capabilities: null }],
        },
      ],
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
    });

    expect(rendered).toContain(CHANNEL_INFO_PIN_MARKER);
    expect(rendered).toContain("https://github.com/pingdotgg/t3code");
    expect(rendered).toContain("/tmp/t3code");
    expect(rendered).toContain("Bot commands (prefer **/omegent**, alias **/agent**):");
    expect(rendered).toContain("/omegent ask prompt:…");
    expect(rendered).toContain("/omegent today-recap");
    expect(rendered).toContain("/omegent help");
    expect(rendered).toContain("/omegent stop");
    expect(rendered).toContain("/omegent compact");
    expect(rendered).toContain("/omegent thread-talk action:on|off|status");
    expect(rendered).toContain("/omegent link ref:<id|url>");
    expect(rendered).toContain("/omegent refresh-indicators");
    expect(rendered).toContain("/omegent assign [github:login]");
    expect(rendered).toContain("/export [count]");
    expect(rendered).toContain("/omegent export");
    expect(rendered).toContain("@Omegent …");
    expect(rendered).toContain("Same actions (fallback)");
    expect(rendered).toContain("/omegent queue prompt:");
    expect(rendered).toContain("--queue parks · --steer injects (steer is the default)");
    expect(rendered).toContain("topic: omegent-queue             Park mid-turn follow-ups");
    expect(rendered).not.toContain("steernow");
    expect(rendered).toContain("—model works too. Short names (opus-5.5).");
    expect(rendered).toContain("claude- and codex- prefixes still work.");
    expect(rendered).toContain("topic: omegent-fast-mode         New threads start in fast mode");
    expect(rendered).toContain("topic: omegent-default-model-<name>  New threads use that model");
    expect(rendered).not.toContain("omegent-alert-link");
    expect(rendered).toContain("delete your message to cancel");
    expect(rendered).toContain("Default provider/model: `codex/gpt-5.4`");
    // Labels pad to the widest provider label ("grok [missing]").
    expect(rendered).toContain("codex           gpt-5.4, gpt-5.5");
    expect(rendered).toContain("grok [missing]  grok-build");
    expect(rendered.length).toBeLessThanOrEqual(DISCORD_MESSAGE_CONTENT_LIMIT);
    // Prefer slash commands before mention fallback in the command block.
    const askIdx = rendered.indexOf("/omegent ask prompt:");
    const mentionIdx = rendered.indexOf("@Omegent …");
    expect(askIdx).toBeGreaterThan(-1);
    expect(mentionIdx).toBeGreaterThan(askIdx);
  });

  it("keeps pin content within Discord's 2000-character limit for large model lists", () => {
    const manyModels = Array.from({ length: 80 }, (_, index) => ({
      slug: `vendor/very-long-model-slug-name-${index}`,
      name: `Model ${index}`,
      isCustom: false,
      capabilities: null,
    }));
    const rendered = renderChannelInfoPin({
      githubUrl: "https://github.com/pingdotgg/t3code",
      workspaceRoot: "/var/lib/t3/src/t3code",
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          models: manyModels,
        },
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          models: manyModels,
        },
        {
          instanceId: ProviderInstanceId.make("grok"),
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          models: manyModels,
        },
        {
          instanceId: ProviderInstanceId.make("cursor"),
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          models: manyModels,
        },
      ],
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
    });

    expect(rendered.length).toBeLessThanOrEqual(DISCORD_MESSAGE_CONTENT_LIMIT);
    expect(rendered).toContain(CHANNEL_INFO_PIN_MARKER);
  });

  it("documents short model names and links an unknown model to the pin", () => {
    expect(
      discordModelLabel({
        slug: "claude-opus-5-5",
        aliases: ["opus", "opus-5.5", "claude-opus-5.5"],
      }),
    ).toBe("opus-5.5");
    expect(discordModelLabel({ slug: "gpt-5.4" })).toBe("gpt-5.4");
    expect(discordModelLabel({ slug: "codex-gpt-5.5" })).toBe("gpt-5.5");

    const rendered = renderChannelInfoPin({
      githubUrl: "https://github.com/pingdotgg/t3code",
      workspaceRoot: "/tmp/t3code",
      providers: [
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          enabled: true,
          installed: true,
          status: "ready",
          availability: "available",
          models: [
            {
              slug: "claude-opus-5-5",
              name: "Claude Opus 5.5",
              aliases: ["opus", "opus-5.5", "claude-opus-5.5"],
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      ],
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5-5",
      },
    });

    expect(rendered).toContain("claudeAgent  opus-5.5");
    expect(rendered).toContain("Default provider/model: `claudeAgent/opus-5.5`");
    expect(rendered).not.toContain("claude-opus-5-5");
    expect(
      formatUnknownDiscordModelMessage({
        requestedModel: "opus-9",
        channelInfoUrl: "https://discord.com/channels/1/2/3",
      }),
    ).toBe(
      "Unknown model `opus-9`. See the pinned channel info: https://discord.com/channels/1/2/3.",
    );
  });
});
