import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { GrokSettings } from "@t3tools/contracts";

import {
  buildGrokCapabilitiesFromModelMeta,
  buildGrokReasoningEffortCapabilities,
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
} from "./GrokProvider.ts";

const decodeGrokSettings = Schema.decodeSync(GrokSettings);

describe("buildGrokCapabilitiesFromModelMeta", () => {
  it("maps Grok ACP reasoning effort meta onto option descriptors with catalog default", () => {
    const caps = buildGrokCapabilitiesFromModelMeta({
      supportsReasoningEffort: true,
      reasoningEffort: "high",
      reasoningEfforts: [
        {
          id: "high",
          value: "high",
          label: "High Effort",
          description: "Highest implementation quality with extensive reasoning",
          default: true,
        },
        {
          id: "medium",
          value: "medium",
          label: "Medium Effort",
          default: false,
        },
        {
          id: "low",
          value: "low",
          label: "Low Effort",
          default: false,
        },
      ],
    });

    const descriptors = caps.optionDescriptors ?? [];
    expect(descriptors).toHaveLength(1);
    const effort = descriptors[0];
    expect(effort?.id).toBe("reasoningEffort");
    expect(effort?.type).toBe("select");
    if (effort?.type !== "select") return;
    expect(effort.currentValue).toBe("high");
    expect(effort.options.map((option) => option.id)).toEqual(["high", "medium", "low"]);
    expect(effort.options.find((option) => option.id === "high")?.isDefault).toBe(true);
    expect(effort.options.find((option) => option.id === "high")?.label).toBe("High");
  });

  it("returns empty capabilities when the model does not support reasoning effort", () => {
    expect(buildGrokCapabilitiesFromModelMeta({ supportsReasoningEffort: false })).toEqual(
      buildGrokReasoningEffortCapabilities([]),
    );
    expect(buildGrokCapabilitiesFromModelMeta(undefined).optionDescriptors).toEqual([]);
  });
});

describe("buildInitialGrokProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(
        decodeGrokSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(decodeGrokSettings({}));
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking Grok");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      const builtIn = snapshot.models.find((model) => model.slug === "grok-build");
      expect(
        (builtIn?.capabilities?.optionDescriptors ?? []).some(
          (descriptor) => descriptor.id === "reasoningEffort",
        ),
      ).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkGrokProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkGrokProviderStatus(
        decodeGrokSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/grok-binary",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken grok install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-version-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Grok CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("reports an error when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-grok-success-" });
          const grokPath = path.join(dir, "grok");
          yield* fs.writeFileString(
            grokPath,
            ["#!/bin/sh", 'printf "grok-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(grokPath, 0o755);

          return yield* checkGrokProviderStatus(
            decodeGrokSettings({ enabled: true, binaryPath: grokPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.models.map((model) => model.slug)).toEqual(["grok-build"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});
