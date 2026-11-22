import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

const electron = vi.hoisted(() => ({ configureWebAuthn: vi.fn() }));

vi.mock("electron", () => ({
  app: { configureWebAuthn: electron.configureWebAuthn },
  dialog: {},
  BrowserWindow: {},
  webContents: {},
}));
vi.mock("electron-webauthn", () => ({}));

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as PreviewPasskeys from "./Passkeys.ts";
import {
  applyGuestWebAuthnPolicy,
  installWebAuthnSessionPolicy,
  previewPopupWindowOptions,
} from "./WebAuthnPolicy.ts";

type HeadersListener = (
  details: { readonly resourceType: string; readonly responseHeaders?: Record<string, string[]> },
  callback: (response: { readonly responseHeaders?: Record<string, string[]> }) => void,
) => void;

const layerFor = (platform: NodeJS.Platform, packageJson: object | undefined) =>
  PreviewPasskeys.layer.pipe(
    Layer.provide(
      Layer.succeed(
        DesktopEnvironment.DesktopEnvironment,
        DesktopEnvironment.DesktopEnvironment.of({
          platform,
          isPackaged: packageJson !== undefined,
          appRoot: "/app",
          path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
        } as DesktopEnvironment.DesktopEnvironment["Service"]),
      ),
    ),
    Layer.provide(
      FileSystem.layerNoop({ readFileString: () => Effect.succeed(JSON.stringify(packageJson)) }),
    ),
  );

const observe = Effect.gen(function* () {
  const passkeys = yield* PreviewPasskeys.PreviewPasskeys;
  yield* passkeys.configure;
  const listeners: HeadersListener[] = [];
  const session = {
    webRequest: { onHeadersReceived: (listener: HeadersListener) => listeners.push(listener) },
  } as unknown as Electron.Session;
  installWebAuthnSessionPolicy(passkeys, session);
  installWebAuthnSessionPolicy(passkeys, session);
  const guest: Electron.WebPreferences = {};
  applyGuestWebAuthnPolicy(passkeys, guest);
  const popup: Electron.BrowserWindowConstructorOptions = previewPopupWindowOptions(passkeys, {
    webPreferences: { sandbox: true },
  });
  const headers = listeners.map((listener) => {
    let response: { readonly responseHeaders?: Record<string, string[]> } = {};
    listener({ resourceType: "mainFrame", responseHeaders: {} }, (value) => {
      response = value;
    });
    return response.responseHeaders?.["Permissions-Policy"];
  });
  return {
    guest: guest.disableBlinkFeatures,
    popup: popup.webPreferences?.disableBlinkFeatures,
    headers,
  };
});

const denied = {
  guest: "WebAuth",
  popup: "WebAuth",
  headers: [["publickey-credentials-get=(), publickey-credentials-create=()"]],
};
const allowed = { guest: undefined, popup: undefined, headers: [] };

describe("preview WebAuthn availability", () => {
  it.effect.each([
    {
      name: "macOS passkey bridge",
      platform: "darwin" as const,
      packageJson: { t3codeWebAuthn: { browserPasskeys: true } },
      expected: allowed,
    },
    {
      name: "macOS Touch ID",
      platform: "darwin" as const,
      packageJson: { t3codeWebAuthn: { touchIdKeychainAccessGroup: "TEAM.group" } },
      expected: allowed,
    },
    {
      name: "macOS without either",
      platform: "darwin" as const,
      packageJson: {},
      expected: denied,
    },
    {
      name: "Windows Hello",
      platform: "win32" as const,
      packageJson: undefined,
      expected: allowed,
    },
    { name: "Linux", platform: "linux" as const, packageJson: undefined, expected: denied },
  ])("$name", ({ platform, packageJson, expected }) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* observe, expected);
    }).pipe(Effect.provide(layerFor(platform, packageJson))),
  );

  it.effect("keeps a failed Touch ID setup denied", () =>
    Effect.gen(function* () {
      electron.configureWebAuthn.mockImplementationOnce(() => {
        throw new Error("missing entitlement");
      });
      assert.deepStrictEqual(yield* observe, denied);
    }).pipe(
      Effect.provide(
        layerFor("darwin", { t3codeWebAuthn: { touchIdKeychainAccessGroup: "TEAM.group" } }),
      ),
    ),
  );

  it("leaves services it never registered alone", () => {
    const guest: Electron.WebPreferences = {};
    applyGuestWebAuthnPolicy({}, guest);
    assert.strictEqual(guest.disableBlinkFeatures, undefined);
  });
});
