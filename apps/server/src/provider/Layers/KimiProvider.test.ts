import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import { buildKimiModelsFromConfigOptions } from "./KimiProvider.ts";

const configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> = [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: "kimi-code/k3",
    options: [
      {
        group: "current",
        name: "Current",
        options: [{ value: "kimi-code/k3", name: "Kimi K3" }],
      },
      {
        group: "legacy",
        name: "Legacy",
        options: [
          { value: "kimi-code/k2.5", name: "Kimi K2.5" },
          { value: "kimi-code/k3", name: "duplicate" },
        ],
      },
    ],
  },
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: "default",
    options: [{ value: "default", name: "Default" }],
  },
  {
    id: "thinking",
    name: "Thinking",
    category: "thought_level",
    type: "select",
    currentValue: "on",
    options: [
      { value: "off", name: "Off" },
      { value: "on", name: "On" },
    ],
  },
];

describe("buildKimiModelsFromConfigOptions", () => {
  it("maps the ACP model catalog and negotiated options", () => {
    const models = buildKimiModelsFromConfigOptions(configOptions);
    expect(models.map(({ slug, name }) => ({ slug, name }))).toEqual([
      { slug: "kimi-code/k3", name: "Kimi K3" },
      { slug: "kimi-code/k2.5", name: "Kimi K2.5" },
    ]);
    expect(models[0]?.capabilities?.optionDescriptors).toEqual([
      expect.objectContaining({
        id: "thinking",
        type: "select",
        currentValue: "on",
      }),
    ]);
  });
});
