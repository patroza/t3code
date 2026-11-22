// @effect-diagnostics nodeBuiltinImport:off - existence contract reads extension source on disk.
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

const providerSource = NodeFS.readFileSync(
  new URL("./chatViewProvider.ts", import.meta.url),
  "utf8",
);

describe("VS Code server system info surface", () => {
  it("keeps horizontal padding when the status bar becomes visible", () => {
    expect(providerSource).toContain("#status:not(:empty) { padding: 0 10px 6px; }");
    expect(providerSource).not.toContain("#status:not(:empty) { padding: 0 0 6px; }");
  });
});
