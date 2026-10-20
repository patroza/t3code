// @effect-diagnostics nodeBuiltinImport:off - existence contract reads extension source on disk.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const extensionSource = NodeFS.readFileSync(new URL("./extension.ts", import.meta.url), "utf8");
const clientSource = NodeFS.readFileSync(new URL("./t3Client.ts", import.meta.url), "utf8");

describe("VS Code identity surface", () => {
  it("prompts for an identity and claims the selected person", () => {
    expect(extensionSource).toContain("createQuickPick");
    expect(extensionSource).toContain("client.claimIdentity(person.personId)");
    expect(extensionSource).toContain("@vscode");
  });

  it("attributes prompts to the VS Code channel", () => {
    expect(clientSource).toContain('sourceHint: { channel: "vscode" }');
  });
});
