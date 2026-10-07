import { FolderClosedIcon } from "lucide-react";
import { describe, expect, it } from "vite-plus/test";

import { FileExplorerIcon, FinderIcon } from "../Icons";
import { resolveDesktopEditorUri, resolveOpenInOptions } from "./OpenInPicker";

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

describe("resolveOpenInOptions", () => {
  it.each([
    ["MacIntel", "Finder", FinderIcon],
    ["Win32", "File Explorer", FileExplorerIcon],
    ["Linux x86_64", "Files", FolderClosedIcon],
  ] as const)("includes the file manager with its icon on %s", (platform, label, Icon) => {
    expect(resolveOpenInOptions(platform, ["cursor", "vscode", "file-manager"])).toEqual([
      expect.objectContaining({ value: "cursor", label: "Cursor" }),
      expect.objectContaining({ value: "vscode", label: "VS Code" }),
      expect.objectContaining({ value: "file-manager", label, Icon }),
    ]);
  });

  it("omits the file manager when unavailable or using remote editors", () => {
    expect(resolveOpenInOptions("MacIntel", ["vscode"])).toEqual([
      expect.objectContaining({ value: "vscode" }),
    ]);
    expect(resolveOpenInOptions("MacIntel", [])).toEqual([]);
  });
});
