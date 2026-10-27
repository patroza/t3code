import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyFastModeSelection,
  topicDefaultModel,
  topicRequestsFastMode,
  topicRequestsQueue,
} from "./fastMode.ts";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");
const grok = ProviderInstanceId.make("grok");

describe("topicRequestsFastMode", () => {
  it("matches the topic tag and ignores lookalikes", () => {
    expect(topicRequestsFastMode("omegent-link-scanner omegent-fast-mode")).toBe(true);
    expect(topicRequestsFastMode("t3-macs-scanner\nomegent-fast-mode")).toBe(true);
    expect(topicRequestsFastMode("Alerts | OMEGENT-FAST-MODE")).toBe(true);
    expect(topicRequestsFastMode("see omegent-fast-mode.")).toBe(true);
    expect(topicRequestsFastMode("omegent-link-scanner")).toBe(false);
    expect(topicRequestsFastMode("omegent-fast-mode-extra")).toBe(false);
    expect(topicRequestsFastMode("omegent-link-fast-mode")).toBe(false);
    expect(topicRequestsFastMode(null)).toBe(false);
    expect(topicRequestsFastMode("")).toBe(false);
  });
});

describe("topicRequestsQueue", () => {
  it("matches the topic tag and ignores lookalikes", () => {
    expect(topicRequestsQueue("omegent-link-scanner omegent-queue")).toBe(true);
    expect(topicRequestsQueue("Alerts | OMEGENT-QUEUE")).toBe(true);
    expect(topicRequestsQueue("see omegent-queue.")).toBe(true);
    expect(topicRequestsQueue("omegent-link-scanner")).toBe(false);
    expect(topicRequestsQueue("omegent-queue-extra")).toBe(false);
    expect(topicRequestsQueue("omegent-link-queue")).toBe(false);
    expect(topicRequestsQueue("omegent-fast-mode")).toBe(false);
    expect(topicRequestsQueue(null)).toBe(false);
    expect(topicRequestsQueue("")).toBe(false);
  });
});

describe("topicDefaultModel", () => {
  it("reads the model name and ignores lookalikes", () => {
    expect(topicDefaultModel("omegent-link-scanner omegent-default-model-opus-5.5")).toBe(
      "opus-5.5",
    );
    expect(topicDefaultModel("Alerts | OMEGENT-DEFAULT-MODEL-GPT-6.1-SOL")).toBe("gpt-6.1-sol");
    expect(topicDefaultModel("see omegent-default-model-grok-4.7.")).toBe("grok-4.7");
    expect(topicDefaultModel("(omegent-default-model-claude-opus-5-5)")).toBe("claude-opus-5-5");
    expect(topicDefaultModel("omegent-default-model-opus-5.5 omegent-default-model-grok-4.7")).toBe(
      "opus-5.5",
    );
    expect(topicDefaultModel("omegent-default-model")).toBeNull();
    expect(topicDefaultModel("omegent-default-model-")).toBeNull();
    expect(topicDefaultModel("omegent-fast-mode")).toBeNull();
    expect(topicDefaultModel("omegent-link-default-model-opus")).toBeNull();
    expect(topicDefaultModel("omegent-default-modelx-opus")).toBeNull();
    expect(topicDefaultModel(null)).toBeNull();
    expect(topicDefaultModel("")).toBeNull();
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
