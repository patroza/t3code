import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyFastModeSelection, topicRequestsFastMode } from "./fastMode.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const grok = ProviderInstanceId.make("grok");

describe("topicRequestsFastMode", () => {
  it("matches the topic tag and ignores lookalikes", () => {
    expect(topicRequestsFastMode("omegent-link-scanner omegent-fast-mode")).toBe(true);
    expect(topicRequestsFastMode("Alerts | OMEGENT-FAST-MODE")).toBe(true);
    expect(topicRequestsFastMode("see omegent-fast-mode.")).toBe(true);
    expect(topicRequestsFastMode("omegent-link-scanner")).toBe(false);
    expect(topicRequestsFastMode("omegent-fast-mode-extra")).toBe(false);
    expect(topicRequestsFastMode("omegent-link-fast-mode")).toBe(false);
    expect(topicRequestsFastMode(null)).toBe(false);
    expect(topicRequestsFastMode("")).toBe(false);
  });
});

describe("applyFastModeSelection", () => {
  it("sets Claude fastMode when the model advertises it", () => {
    expect(
      applyFastModeSelection({ instanceId: claude, model: "claude-opus-5-5" }, [
        {
          instanceId: claude,
          driver: "claudeAgent",
          models: [
            {
              slug: "claude-opus-5-5",
              capabilities: {
                optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
              },
            },
          ],
        },
      ]),
    ).toEqual({
      instanceId: claude,
      model: "claude-opus-5-5",
      options: [{ id: "fastMode", value: true }],
    });
  });

  it("selects the Codex fast service tier", () => {
    expect(
      applyFastModeSelection(
        {
          instanceId: codex,
          model: "gpt-6.1-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
        [
          {
            instanceId: codex,
            driver: "codex",
            models: [
              {
                slug: "gpt-6.1-sol",
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "serviceTier",
                      label: "Service Tier",
                      type: "select",
                      options: [
                        { id: "standard", label: "Standard" },
                        { id: "fast", label: "Fast" },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        ],
      ),
    ).toEqual({
      instanceId: codex,
      model: "gpt-6.1-sol",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "serviceTier", value: "fast" },
      ],
    });
  });

  it("uses Grok's build-fast catalog sibling", () => {
    expect(
      applyFastModeSelection({ instanceId: grok, model: "grok-4.7" }, [
        {
          instanceId: grok,
          driver: "grok",
          models: [{ slug: "grok-4.7" }, { slug: "grok-4.7-build-fast" }, { slug: "grok-4.6" }],
        },
      ]),
    ).toEqual({ instanceId: grok, model: "grok-4.7-build-fast" });
  });

  it("keeps an already-fast Grok model", () => {
    const selection = { instanceId: grok, model: "grok-4.7-build-fast" };
    const resolved = applyFastModeSelection(selection, [
      {
        instanceId: grok,
        driver: "grok",
        models: [{ slug: "grok-4.7" }, { slug: "grok-4.7-build-fast" }],
      },
    ]);
    expect(resolved).toEqual(selection);
    expect(resolved).not.toBe(selection);
  });

  it("leaves a model unchanged when the catalog has no fast control", () => {
    const selection = { instanceId: grok, model: "grok-4.6" };
    expect(
      applyFastModeSelection(selection, [
        {
          instanceId: grok,
          driver: "grok",
          models: [{ slug: "grok-4.6" }, { slug: "grok-4.7-build-fast" }],
        },
      ]),
    ).toBe(selection);
  });

  it("still sets fastMode for Codex when the snapshot omitted descriptors", () => {
    expect(
      applyFastModeSelection({ instanceId: codex, model: "gpt-6.1-sol" }, [
        { instanceId: codex, driver: "codex", models: [{ slug: "gpt-6.1-sol" }] },
      ]),
    ).toEqual({
      instanceId: codex,
      model: "gpt-6.1-sol",
      options: [{ id: "fastMode", value: true }],
    });
  });
});
