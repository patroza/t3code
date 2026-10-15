// @effect-diagnostics nodeBuiltinImport:off - Owns Playwright fixture resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { chromium } from "playwright-core";
import { afterEach, beforeAll, describe, expect, it } from "vite-plus/test";

import { ServerBrowserContexts } from "./ServerBrowserContexts.ts";

describe("streamed browser authentication", () => {
  let pool: ServerBrowserContexts | undefined;
  let profilesDir: string | undefined;
  let executable: string;
  let nativeOther: unknown;

  beforeAll(async () => {
    // CI installs only Playwright's headless shell; executablePath() names full Chrome.
    const browser = await chromium.launch({ headless: true, args: ["--enable-automation"] });
    try {
      const cdp = await browser.newBrowserCDPSession();
      const command = await cdp.send("Browser.getBrowserCommandLine");
      if (!command.arguments[0]) throw new Error("Missing browser executable");
      executable = command.arguments[0];
      const page = await browser.newPage();
      await page.route("https://auth.test/**", (route) =>
        route.fulfill({ body: "<!doctype html>" }),
      );
      await page.goto("https://auth.test/");
      nativeOther = await page.evaluate(`navigator.credentials.get({}).then(
        value => ({value}), error => ({error: error.name})
      )`);
    } finally {
      await browser.close();
    }
  });

  afterEach(async () => {
    await pool?.close();
    if (profilesDir) await NodeFSP.rm(profilesDir, { recursive: true, force: true });
  });

  it.each([
    { name: "persistent profile", profile: "default", isolationKey: undefined },
    { name: "isolated agent", profile: "default", isolationKey: "agent" },
    { name: "incognito", profile: INCOGNITO_BROWSER_PROFILE_ID, isolationKey: undefined },
  ])(
    "offers usable sign-in methods from document start in a $name",
    async ({ profile, isolationKey }) => {
      profilesDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-auth-"));
      pool = new ServerBrowserContexts({
        profilesDir,
        executable: async () => executable,
        env: { ...process.env, T3CODE_SERVER_BROWSER_SANDBOX: "0" },
      });
      const context = await pool.contextFor(profile, isolationKey);
      await context.route("https://auth.test/**", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><script>
        document.title = typeof PublicKeyCredential === "undefined" && !("PublicKeyCredential" in window)
          ? "Phone sign-in" : "Device passkey";
      </script>${route.request().url().endsWith("/") ? '<a href="/popup" target="_blank">Sign in</a><iframe src="/frame"></iframe>' : ""}`,
        }),
      );
      const page = await context.newPage();
      await page.goto("https://auth.test/");
      expect(await page.evaluate("isSecureContext")).toBe(true);
      expect(await page.title()).toBe("Phone sign-in");
      await page.reload();
      expect(await page.title()).toBe("Phone sign-in");
      expect(await page.frames()[1]!.title()).toBe("Phone sign-in");
      const popupOpened = page.waitForEvent("popup");
      await page.getByRole("link", { name: "Sign in" }).click();
      const popup = await popupOpened;
      await popup.waitForLoadState();
      expect(await popup.title()).toBe("Phone sign-in");

      expect(
        await page.evaluate(`(async () => {
      const failure = async (request) => { try { await request(); return "resolved"; } catch (error) { return error.name; } };
      const controller = new AbortController();
      controller.abort(new DOMException("Cancelled by the site", "AbortError"));
      return {
        get: await failure(() => navigator.credentials.get({publicKey: {challenge: new Uint8Array(32), timeout: 600000}})),
        create: await failure(() => navigator.credentials.create({publicKey: {
          challenge: new Uint8Array(32), rp: {name: "Auth fixture"},
          user: {id: new Uint8Array([1]), name: "fixture", displayName: "Fixture"},
          pubKeyCredParams: [{type: "public-key", alg: -7}], timeout: 600000,
        }})),
        other: await navigator.credentials.get({}).then(value => ({value}), error => ({error: error.name})),
        aborted: await failure(() => navigator.credentials.get({publicKey: {challenge: new Uint8Array(32)}, signal: controller.signal})),
        container: typeof navigator.credentials,
      };
    })()`),
      ).toEqual({
        get: "NotAllowedError",
        create: "NotAllowedError",
        other: nativeOther,
        aborted: "AbortError",
        container: "object",
      });
    },
  );
});
