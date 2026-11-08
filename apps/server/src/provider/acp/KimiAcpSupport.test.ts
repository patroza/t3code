import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import { applyKimiAcpModelSelection, buildKimiAcpSpawnInput } from "./KimiAcpSupport.ts";

describe("buildKimiAcpSpawnInput", () => {
  it("builds the configured Kimi ACP command", () => {
    expect(
      buildKimiAcpSpawnInput({ binaryPath: "/opt/kimi/bin/kimi" }, "/tmp/project", {
        KIMI_CODE_HOME: "/tmp/kimi-home",
      }),
    ).toEqual({
      command: "/opt/kimi/bin/kimi",
      args: ["acp"],
      cwd: "/tmp/project",
      forceKillAfter: "1 second",
      env: { KIMI_CODE_HOME: "/tmp/kimi-home" },
    });
  });
});

describe("applyKimiAcpModelSelection", () => {
  it.effect("sets the model before negotiated Kimi config options", () =>
    Effect.gen(function* () {
      const calls: Array<ReadonlyArray<string | boolean>> = [];
      const runtime = {
        setModel: (model: string) => Effect.sync(() => calls.push(["model", model])),
        setConfigOption: (id: string, value: string | boolean) =>
          Effect.sync(() => calls.push(["config", id, value])),
      };
      yield* applyKimiAcpModelSelection({
        runtime: runtime as never,
        model: "kimi-code/k3",
        selections: [{ id: "thinking", value: "on" }],
        mapError: ({ cause }) => cause,
      });
      expect(calls).toEqual([
        ["model", "kimi-code/k3"],
        ["config", "thinking", "on"],
      ]);
    }),
  );
});
