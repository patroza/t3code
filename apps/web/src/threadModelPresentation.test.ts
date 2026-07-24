import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";
import type { ModelSelection, ServerConfig } from "@t3tools/contracts";
import { resolveThreadModelPresentation } from "./threadModelPresentation";

describe("resolveThreadModelPresentation", () => {
  it("uses provider display name and model short name when available", () => {
    const modelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4-codex",
    };
    const serverConfig = {
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: "codex",
          displayName: "Codex",
          enabled: true,
          installed: true,
          version: "1.0.0",
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-07-06T00:00:00.000Z",
          models: [
            {
              slug: "gpt-5.4-codex",
              name: "GPT-5.4 Codex",
              shortName: "GPT-5.4",
              isCustom: false,
              capabilities: null,
            },
          ],
          slashCommands: [],
          skills: [],
        },
      ],
    } as unknown as ServerConfig;

    expect(resolveThreadModelPresentation(modelSelection, serverConfig)).toMatchObject({
      driverKind: "codex",
      providerLabel: "Codex",
      modelLabel: "GPT-5.4",
      tooltip: "Codex · GPT-5.4 (gpt-5.4-codex)",
    });
  });

  it("falls back to instance id and raw model slug when the provider is unavailable", () => {
    const modelSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex_work"),
      model: "custom-model",
    };

    expect(resolveThreadModelPresentation(modelSelection, null)).toEqual({
      driverKind: null,
      providerLabel: "codex_work",
      modelLabel: "custom-model",
      tooltip: "codex_work · custom-model",
    });
  });
});
