import { describe, expect, it, vi } from "vite-plus/test";

import { highlightCode, nativeHighlightsReady } from "./highlights";

vi.hoisted(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

vi.mock("./highlightsNativeBinding", () => ({
  createNativeHighlights() {
    throw new Error(
      "Failed to install Nitro: installJSIBindingsWithRuntime: was not called - JSI Bindings could not be installed!",
    );
  },
}));

describe("highlights launch", () => {
  it("still highlights as plain text when Nitro fails to install", async () => {
    await expect(nativeHighlightsReady).resolves.toBeUndefined();
    const code = "const a = 1;\nconst b = 2;";
    expect(highlightCode(code, "typescript", "dark")).toEqual([
      [{ content: "const a = 1;", color: null, fontStyle: null }],
      [{ content: "const b = 2;", color: null, fontStyle: null }],
    ]);
  });
});
