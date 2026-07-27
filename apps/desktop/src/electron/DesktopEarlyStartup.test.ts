import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  type DesktopEarlyStartupApp,
  configureDesktopEarlyStartup,
} from "./DesktopEarlyStartup.ts";

function makeApp() {
  const exit = vi.fn();
  const getVersion = vi.fn(() => "1.2.3");
  const app: DesktopEarlyStartupApp = {
    exit,
    getVersion,
  };

  return { app, exit, getVersion };
}

describe("configureDesktopEarlyStartup", () => {
  it.each(["--version", "-v"] as const)(
    "prints the packaged version for %s",
    (flag: "--version" | "-v") => {
      const { app, exit, getVersion } = makeApp();
      const writeStdout = vi.fn();

      configureDesktopEarlyStartup({
        app,
        argv: ["t3code", flag],
        writeStdout,
      });

      assert.strictEqual(getVersion.mock.calls.length, 1);
      assert.deepStrictEqual(writeStdout.mock.calls, [["1.2.3\n"]]);
      assert.deepStrictEqual(exit.mock.calls, [[0]]);
    },
  );

  it("does nothing for an ordinary launch", () => {
    const { app, exit, getVersion } = makeApp();
    const writeStdout = vi.fn();

    configureDesktopEarlyStartup({
      app,
      argv: ["t3code"],
      writeStdout,
    });

    assert.strictEqual(getVersion.mock.calls.length, 0);
    assert.strictEqual(writeStdout.mock.calls.length, 0);
    assert.strictEqual(exit.mock.calls.length, 0);
  });
});
