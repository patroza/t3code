// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the filesystem boundary.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NetService from "@t3tools/shared/Net";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestConsole from "effect/testing/TestConsole";
import { Command, CliError } from "effect/cli";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { cli } from "../binCli.ts";
import * as ServerConfig from "../config.ts";
import { resolveCliAuthConfig } from "./config.ts";

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, NetService.layer);

const runCli = (args: ReadonlyArray<string>) => Command.runWith(cli, { version: "0.0.0" })(args);

const provideCliTestLayers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provide(effect, Layer.mergeAll(layerCliRuntime, TestConsole.layer));

const captureStdout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  provideCliTestLayers(
    Effect.gen(function* () {
      yield* effect;
      return (
        (yield* TestConsole.logLines).findLast(
          (line): line is string => typeof line === "string",
        ) ?? ""
      );
    }),
  );

const mcpClientArgs = [
  "--subject",
  "mcp-client",
  "--scope",
  "orchestration:read",
  "--scope",
  "orchestration:operate",
];

const authenticateMcpClient = (baseDir: string, token: string) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    return yield* Effect.gen(function* () {
      const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
      return yield* environmentAuth.authenticateMcpClient({
        cookies: {},
        headers: { authorization: `Bearer ${token}` },
      } as unknown as Parameters<typeof environmentAuth.authenticateMcpClient>[0]);
    }).pipe(
      Effect.provide(
        EnvironmentAuth.layerRuntime.pipe(Layer.provideMerge(ServerConfig.layer(config))),
      ),
    );
  });

const tempBaseDir = () =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-cli-runtime-mode-ceiling-"));

describe("auth session issue --runtime-mode-ceiling", () => {
  it.effect.each([
    { label: "the given ceiling", extra: ["--runtime-mode-ceiling", "auto"], access: "auto" },
    { label: "approval-required without the flag", extra: [], access: "approval-required" },
  ] as const)("issues an MCP client token with $label", ({ extra, access }) =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = tempBaseDir();
        const token = yield* captureStdout(
          runCli([
            "auth",
            "session",
            "issue",
            "--base-dir",
            baseDir,
            "--token-only",
            ...mcpClientArgs,
            ...extra,
          ]),
        );
        const client = yield* authenticateMcpClient(baseDir, token);
        assert.equal(client.access, access);
      }),
    ),
  );

  it.effect.each([
    { label: "without the mcp-client subject", args: ["--scope", "orchestration:operate"] },
    {
      label: "without the operate scope",
      args: ["--subject", "mcp-client", "--scope", "orchestration:read"],
    },
  ])("refuses the flag $label without issuing a token", ({ args }) =>
    provideCliTestLayers(
      Effect.gen(function* () {
        const baseDir = tempBaseDir();
        const error = yield* runCli([
          "auth",
          "session",
          "issue",
          "--base-dir",
          baseDir,
          ...args,
          "--runtime-mode-ceiling",
          "full-access",
        ]).pipe(Effect.flip);
        assert.isTrue(CliError.isCliError(error) && error._tag === "UserError");
        const listOutput = yield* captureStdout(
          runCli(["auth", "session", "list", "--base-dir", baseDir, "--json"]),
        );
        assert.deepEqual(JSON.parse(listOutput), []);
      }),
    ),
  );
});
