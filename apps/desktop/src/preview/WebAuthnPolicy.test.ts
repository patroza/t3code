// @effect-diagnostics nodeBuiltinImport:off - Owns an isolated Electron fixture and its temporary profile.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { expect, it } from "vite-plus/test";

import { denyWebAuthnRequests, disableWebAuthn } from "./WebAuthnPolicy.ts";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const require = NodeModule.createRequire(import.meta.url);

it("settles unsupported native ceremonies across documents, frames and OAuth popups", async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-auth-"));
  try {
    const fixture = NodePath.join(directory, "fixture.cjs");
    await NodeFSP.writeFile(
      fixture,
      `const { app, BrowserWindow, session } = require("electron");
const http = require("node:http");
const disableWebAuthn = ${disableWebAuthn.toString()};
const denyWebAuthnRequests = ${denyWebAuthnRequests.toString()};
app.setPath("userData", ${JSON.stringify(NodePath.join(directory, "profile"))});
app.commandLine.appendSwitch("no-sandbox");
setTimeout(() => app.exit(2), 20000).unref();
app.whenReady().then(async () => {
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.setHeader("Permissions-Policy", "geolocation=(), publickey-credentials-get=*, publickey-credentials-create=*");
    response.setHeader("X-Preserved", "fixture");
    response.setHeader("Set-Cookie", "auth_fixture=kept; SameSite=Lax");
    const port = server.address().port;
    response.end('<!doctype html><script>globalThis.availableAtStart = typeof PublicKeyCredential</script>' +
      (request.url === "/" ? '<iframe src="/same"></iframe><iframe src="http://127.0.0.1:' + port + '/cross" allow="publickey-credentials-get; publickey-credentials-create"></iframe>' : ""));
  });
  await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
  const browserSession = session.fromPartition("auth-fixture");
  browserSession.webRequest.onHeadersReceived((details, callback) => callback({responseHeaders: denyWebAuthnRequests(details.responseHeaders)}));
  const window = new BrowserWindow({show: false, webPreferences: {webviewTag: true}});
  const preferences = {sandbox: true, nodeIntegration: false, nodeIntegrationInSubFrames: false, contextIsolation: false, partition: "auth-fixture", disableBlinkFeatures: "ExistingFeature"};
  disableWebAuthn(preferences);
  window.webContents.on("will-attach-webview", (_event, supplied) => Object.assign(supplied, preferences));
  const attached = new Promise(resolve => window.webContents.once("did-attach-webview", (_event, guest) => resolve(guest)));
  await window.loadURL("data:text/html," + encodeURIComponent('<webview allowpopups partition="auth-fixture" style="width:500px;height:500px" src="http://localhost:' + server.address().port + '/"></webview>'));
  const guest = await attached;
  const loaded = async contents => { if (contents.isLoading()) await new Promise(resolve => contents.once("did-stop-loading", resolve)); };
  await loaded(guest);
  const inspect = async frame => frame.executeJavaScript(
    "(" + (async () => {
      const settle = promise => Promise.race([
        promise.then(value => ({value: value?.constructor?.name ?? null}), error => ({error: error.name})),
        new Promise(resolve => setTimeout(() => resolve({pending: true}), 300)),
      ]);
      const [get, create, password] = await Promise.all([
        settle(navigator.credentials.get({publicKey: {challenge: new Uint8Array(32)}})),
        settle(navigator.credentials.create({publicKey: {challenge: new Uint8Array(32), rp: {name: "fixture"}, user: {id: new Uint8Array([1]), name: "fixture", displayName: "Fixture"}, pubKeyCredParams: [{type: "public-key", alg: -7}]}})),
        settle(navigator.credentials.create({password: {id: "fixture", password: "fixture"}})),
      ]);
      return {availableAtStart, cookie: document.cookie, conditional: typeof PublicKeyCredential === "undefined" ? "unavailable" : await PublicKeyCredential.isConditionalMediationAvailable(), get, create, password, geolocation: document.featurePolicy.allowsFeature("geolocation"), preserved: (await fetch(location.href)).headers.get("x-preserved")};
    }).toString() + ")()", true);
  const frames = await Promise.all(guest.mainFrame.framesInSubtree.map(inspect));
  guest.reload();
  await loaded(guest);
  const reloaded = await inspect(guest.mainFrame);
  guest.setWindowOpenHandler(() => ({action: "allow", overrideBrowserWindowOptions: {show: false, webPreferences: {...preferences, contextIsolation: true}}}));
  const opened = new Promise(resolve => guest.once("did-create-window", resolve));
  await guest.executeJavaScript('window.open("http://localhost:' + server.address().port + '/oauth", "oauth", "width=400,height=300"); void 0', true);
  const popup = await opened;
  await loaded(popup.webContents);
  const oauth = await inspect(popup.webContents.mainFrame);
  process.stdout.write("AUTH_FIXTURE:" + JSON.stringify({frames, reloaded, oauth, popupUsesSession: popup.webContents.session === browserSession, features: preferences.disableBlinkFeatures}) + "\\n");
  popup.destroy(); window.destroy(); server.close(); app.quit();
}).catch(error => { console.error(error); app.exit(1); });`,
    );
    const electron = require("electron") as string;
    const electronArgs = ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", fixture];
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Launches the installed native fixture on its actual host, outside Effect.
    const platform = NodeOS.platform();
    const { stdout } = await execFile(
      platform === "linux" ? "xvfb-run" : electron,
      platform === "linux"
        ? ["-a", electron, "--ozone-platform=x11", ...electronArgs]
        : electronArgs,
      { timeout: 30_000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } },
    );
    const result = JSON.parse(stdout.split("AUTH_FIXTURE:")[1]!) as {
      frames: unknown[];
      oauth: unknown;
      reloaded: unknown;
      popupUsesSession: boolean;
      features: string;
    };
    expect(result.features).toBe("ExistingFeature,WebAuth");
    expect(result.frames).toHaveLength(3);
    expect(result.popupUsesSession).toBe(true);
    for (const [index, document] of [...result.frames, result.reloaded, result.oauth].entries()) {
      expect(document).toEqual({
        availableAtStart: "undefined",
        cookie: index === 2 ? "" : "auth_fixture=kept",
        conditional: "unavailable",
        get: { error: "NotAllowedError" },
        create: { error: "NotAllowedError" },
        password: { value: "PasswordCredential" },
        geolocation: false,
        preserved: "fixture",
      });
    }
  } finally {
    await NodeFSP.rm(directory, { recursive: true, force: true });
  }
});
