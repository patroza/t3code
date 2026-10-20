import { assert, describe, it } from "@effect/vitest";

import {
  ServerCliBuildAssetMissingError,
  ServerCliCommandExitError,
  ServerCliWebClientBundleMissingError,
} from "./cliErrors.ts";

describe("server CLI errors", () => {
  it("preserves failed command context without changing its message", () => {
    const error = new ServerCliCommandExitError({
      command: "vp",
      args: ["pm", "publish"],
      cwd: "/repo",
      exitCode: 17,
    });

    assert.equal(error._tag, "ServerCliCommandExitError");
    assert.equal(error.command, "vp");
    assert.deepEqual(error.args, ["pm", "publish"]);
    assert.equal(error.cwd, "/repo");
    assert.equal(error.exitCode, 17);
    assert.equal(error.message, "Command exited with non-zero exit code (17)");
  });

  it("preserves a representative missing asset path", () => {
    const error = new ServerCliBuildAssetMissingError({ assetPath: "/repo/server.mjs" });

    assert.equal(error.assetPath, "/repo/server.mjs");
    assert.equal(
      error.message,
      "Missing build asset: /repo/server.mjs. Run the build subcommand first.",
    );
  });

  it("explains a missing web client bundle at package time", () => {
    const error = new ServerCliWebClientBundleMissingError({ webDistPath: "/repo/apps/web/dist" });

    assert.equal(error.webDistPath, "/repo/apps/web/dist");
    assert.include(error.message, "Web client dist is missing");
    assert.include(error.message, "/repo/apps/web/dist");
  });
});
