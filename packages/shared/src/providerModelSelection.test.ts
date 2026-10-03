import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  parseProviderModelFlags,
  resolveProviderModelSelection,
} from "./providerModelSelection.ts";

const providers = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    models: [
      {
        slug: "gpt-5.4",
        name: "GPT-5.4",
        shortName: "5.4",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "gpt-5.6",
        name: "GPT-5.6",
        shortName: "5.6",
        isCustom: false,
        capabilities: null,
      },
    ],
  },
  {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        isCustom: false,
        capabilities: null,
      },
    ],
  },
  {
    instanceId: ProviderInstanceId.make("grok"),
    driver: ProviderDriverKind.make("grok"),
    enabled: true,
    installed: true,
    models: [
      {
        slug: "grok-build",
        name: "Grok Build",
        isCustom: false,
        capabilities: null,
      },
    ],
  },
  {
    instanceId: ProviderInstanceId.make("cursor"),
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    models: [
      {
        slug: "claude-opus-4-6",
        name: "Opus 4.6",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "composer-2",
        name: "Composer 2",
        isCustom: false,
        capabilities: null,
      },
    ],
  },
];

const fallbackSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};

describe("provider/model message settings", () => {
  it("strips provider and model flags from the agent prompt", () => {
    expect(
      parseProviderModelFlags(
        "--discord --provider claudeAgent investigate --model claude-opus-4-6 now",
      ),
    ).toEqual({
      provider: "claudeAgent",
      model: "claude-opus-4-6",
      discord: true,
      prompt: "investigate now",
    });
  });

  it("resolves a provider-only override to an available model", () => {
    expect(
      resolveProviderModelSelection({
        providers,
        preferredSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        fallbackSelection,
        overrideInstanceId: "claudeAgent",
      }),
    ).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-4-6",
    });
  });

  it("matches a model-only override to its native provider instead of the sticky default", () => {
    expect(
      resolveProviderModelSelection({
        providers,
        preferredSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        fallbackSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        overrideModel: "gpt-5.6",
      }),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.6",
    });
  });

  it("prefers the native Claude provider over Cursor for a Claude model-only override", () => {
    expect(
      resolveProviderModelSelection({
        providers,
        preferredSelection: {
          instanceId: ProviderInstanceId.make("grok"),
          model: "grok-build",
        },
        fallbackSelection,
        overrideModel: "claude-opus-4-6",
      }),
    ).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-4-6",
    });
  });

  it("keeps the sticky provider when the model-only override is available there", () => {
    expect(
      resolveProviderModelSelection({
        providers,
        preferredSelection: {
          instanceId: ProviderInstanceId.make("cursor"),
          model: "composer-2",
        },
        fallbackSelection,
        overrideModel: "claude-opus-4-6",
      }),
    ).toEqual({
      instanceId: "cursor",
      model: "claude-opus-4-6",
    });
  });
});
