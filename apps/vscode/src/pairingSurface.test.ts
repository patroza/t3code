// @effect-diagnostics nodeBuiltinImport:off - existence contract reads extension source on disk.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const desktopFavoritesSource = NodeFS.readFileSync(
  new URL("./desktopFavorites.ts", import.meta.url),
  "utf8",
);
const extensionSource = NodeFS.readFileSync(new URL("./extension.ts", import.meta.url), "utf8");
const clientSource = NodeFS.readFileSync(new URL("./t3Client.ts", import.meta.url), "utf8");
const providerSource = NodeFS.readFileSync(
  new URL("./chatViewProvider.ts", import.meta.url),
  "utf8",
);
const webviewSource = NodeFS.readFileSync(new URL("./webview.ts", import.meta.url), "utf8");

describe("VS Code pairing and dead bootstrap removal surface", () => {
  it("removes the dead local-bootstrap-credential and connectWithBootstrap paths", () => {
    expect(desktopFavoritesSource).not.toContain("local-bootstrap-credential");
    expect(desktopFavoritesSource).not.toContain("readDesktopBootstrapCredential");
    expect(extensionSource).not.toContain("local-bootstrap-credential");
    expect(extensionSource).not.toContain("readDesktopBootstrapCredential");
    expect(extensionSource).not.toContain("connectWithBootstrap");
    expect(clientSource).not.toContain("local-bootstrap-credential");
    expect(clientSource).not.toContain("connectWithBootstrap");
  });

  it("renders a Pair with Server action in the sidebar webview wired to the pair message", () => {
    expect(providerSource).toContain('data-testid="pair-server-button"');
    expect(providerSource).toContain('aria-label="Pair with Server"');
    expect(providerSource).toContain('case "pair"');
    expect(webviewSource).toContain("pair-server");
    expect(webviewSource).toContain('type: "pair"');
  });

  it("checks server compatibility before exchanging a one-time pairing credential", () => {
    const compatibilityCheckIndex = extensionSource.indexOf("fetchCompatibleDescriptor");
    const exchangeIndex = extensionSource.indexOf("exchangePairingCredential");
    expect(compatibilityCheckIndex).toBeGreaterThan(-1);
    expect(exchangeIndex).toBeGreaterThan(compatibilityCheckIndex);
  });
});
