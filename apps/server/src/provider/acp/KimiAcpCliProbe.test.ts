/**
 * Optional integration check against a real Kimi Code CLI install.
 * Enable with T3_KIMI_ACP_PROBE=1 and optionally set T3_KIMI_BINARY.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { checkKimiProviderStatus } from "../Layers/KimiProvider.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

describe.runIf(process.env.T3_KIMI_ACP_PROBE === "1")("Kimi ACP CLI probe", () => {
  it.effect("authenticates and discovers models from session config", () =>
    Effect.gen(function* () {
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime;
      const started = yield* runtime.start();
      const modelOption = started.sessionSetupResult.configOptions?.find(
        (option) => option.id === "model",
      );
      expect(started.initializeResult.agentInfo?.name).toContain("Kimi");
      expect(modelOption?.type).toBe("select");
      if (modelOption?.type === "select") {
        expect(modelOption.options.length).toBeGreaterThan(0);
      }
    }).pipe(
      Effect.provide(
        AcpSessionRuntime.layer({
          spawn: {
            command: process.env.T3_KIMI_BINARY ?? "kimi",
            args: ["acp"],
            cwd: process.cwd(),
          },
          cwd: process.cwd(),
          clientInfo: { name: "t3-kimi-probe", version: "0.0.0" },
          authMethodId: "login",
        }),
      ),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    ),
  );

  it.effect("completes the deployed provider status probe", () =>
    checkKimiProviderStatus({
      enabled: true,
      binaryPath: process.env.T3_KIMI_BINARY ?? "kimi",
      customModels: [],
    }).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot.status).toBe("ready");
          expect(snapshot.models.length).toBeGreaterThan(0);
        }),
      ),
      Effect.provide(NodeServices.layer),
    ),
  );
});
