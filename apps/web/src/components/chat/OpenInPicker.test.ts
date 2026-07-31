import { describe, expect, it } from "vite-plus/test";

import { resolveDesktopEditorUri } from "./OpenInPicker";

describe("resolveDesktopEditorUri", () => {
  it("builds a vscode://file URL for VS Code", () => {
    expect(resolveDesktopEditorUri("vscode", "/home/tester/projects/example")).toBe(
      "vscode://file/home/tester/projects/example?windowId=_blank",
    );
  });

  it("builds a vscode-insiders://file URL for VS Code Insiders", () => {
    expect(resolveDesktopEditorUri("vscode-insiders", "/home/tester/project")).toBe(
      "vscode-insiders://file/home/tester/project?windowId=_blank",
    );
  });

  it("builds a cursor://file URL for Cursor", () => {
    expect(resolveDesktopEditorUri("cursor", "/home/tester/project")).toBe(
      "cursor://file/home/tester/project?windowId=_blank",
    );
  });

  it("encodes path segments with spaces and reserved characters", () => {
    expect(resolveDesktopEditorUri("vscode", "/home/tester/project with spaces")).toBe(
      "vscode://file/home/tester/project%20with%20spaces?windowId=_blank",
    );
  });

  it("returns null for editors without a URL scheme", () => {
    expect(resolveDesktopEditorUri("vscodium", "/home/tester/project")).toBeNull();
    expect(resolveDesktopEditorUri("zed", "/home/tester/project")).toBeNull();
  });

  it("returns null for a non-absolute path", () => {
    expect(resolveDesktopEditorUri("vscode", "relative/path")).toBeNull();
  });
});
