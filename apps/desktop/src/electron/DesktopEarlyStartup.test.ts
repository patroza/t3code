import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import {
  type DesktopEarlyStartupApp,
  configureDesktopEarlyStartup,
} from "./DesktopEarlyStartup.ts";

function makeApp() {
  const appendSwitch = vi.fn();
  const exit = vi.fn();
  const getVersion = vi.fn(() => "1.2.3");
  const app: DesktopEarlyStartupApp = {
    commandLine: { appendSwitch },
    exit,
    getVersion,
  };

  return { app, appendSwitch, exit, getVersion };
}

describe("configureDesktopEarlyStartup", () => {
  it("forces the libsecret password store on Linux", () => {
    const { app, appendSwitch } = makeApp();

    configureDesktopEarlyStartup({
      app,
      argv: ["t3code"],
      platform: "linux",
      writeStdout: vi.fn(),
    });

    assert.deepStrictEqual(appendSwitch.mock.calls, [["password-store", "gnome-libsecret"]]);
  });

  it.each(["darwin", "win32"] as const)(
    "does not override the password store on %s",
    (platform: "darwin" | "win32") => {
      const { app, appendSwitch } = makeApp();

      configureDesktopEarlyStartup({
        app,
        argv: ["t3code"],
        platform,
        writeStdout: vi.fn(),
      });

      assert.strictEqual(appendSwitch.mock.calls.length, 0);
    },
  );

  it.each(["--version", "-v"] as const)(
    "prints the packaged version for %s",
    (flag: "--version" | "-v") => {
      const { app, exit, getVersion } = makeApp();
      const writeStdout = vi.fn();

      configureDesktopEarlyStartup({
        app,
        argv: ["t3code", flag],
        platform: "linux",
        writeStdout,
      });

      assert.strictEqual(getVersion.mock.calls.length, 1);
      assert.deepStrictEqual(writeStdout.mock.calls, [["1.2.3\n"]]);
      assert.deepStrictEqual(exit.mock.calls, [[0]]);
    },
  );
});
