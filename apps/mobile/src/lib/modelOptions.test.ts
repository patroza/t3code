import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ServerConfig } from "@t3tools/contracts";

import {
  buildModelMenuActions,
  buildModelOptions,
  groupByProvider,
  resolveSelectableModelSelection,
} from "./modelOptions";

describe("mobile model options", () => {
  it("folds legacy models into a provider-scoped menu", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.6-sol",
              name: "GPT-5.6 Sol",
              isCustom: false,
              capabilities: null,
            },
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const actions = buildModelMenuActions(groupByProvider(buildModelOptions(config, null)), null);

    expect(actions).toMatchObject([
      {
        title: "Codex",
        subactions: [{ id: "model:codex:gpt-5.6-sol", title: "GPT-5.6 Sol" }],
      },
      {
        id: "legacy-models:codex",
        title: "Codex legacy models",
        subactions: [{ id: "model:codex:gpt-5.4", title: "GPT-5.4" }],
      },
    ]);
  });

  it("omits an empty provider menu when every model is legacy", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-5.4",
              name: "GPT-5.4",
              isCustom: false,
              isLegacy: true,
              capabilities: null,
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    expect(
      buildModelMenuActions(groupByProvider(buildModelOptions(config, null)), null),
    ).toMatchObject([
      {
        id: "legacy-models:codex",
        title: "Codex legacy models",
        subactions: [{ id: "model:codex:gpt-5.4" }],
      },
    ]);
  });

  it("normalizes a legacy fallback selection against current capabilities", () => {
    const config = {
      providers: [
        {
          instanceId: "codex",
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          auth: { status: "authenticated" },
          models: [
            {
              slug: "gpt-test",
              name: "GPT Test",
              isCustom: false,
              capabilities: {
                optionDescriptors: [
                  {
                    id: "serviceTier",
                    label: "Service Tier",
                    type: "select",
                    options: [
                      { id: "default", label: "Standard", isDefault: true },
                      { id: "priority", label: "Fast" },
                    ],
                    currentValue: "default",
                  },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as ServerConfig;

    const [option] = buildModelOptions(config, {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-test",
      options: [{ id: "fastMode", value: true }],
    });

    expect(option?.capabilities?.optionDescriptors?.[0]?.id).toBe("serviceTier");
    expect(option?.selection.options).toEqual([{ id: "serviceTier", value: "default" }]);
  });
});
