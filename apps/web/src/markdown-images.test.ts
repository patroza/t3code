import { describe, expect, it } from "vite-plus/test";

import { isLocalMarkdownImageSrc, normalizeLocalMarkdownImageSrc } from "./markdown-images";

describe("markdown local images", () => {
  it("normalizes angle-bracket, file://, and attachment: destinations", () => {
    expect(
      normalizeLocalMarkdownImageSrc("</var/lib/t3/.codex/generated_images/abc/call_x.png>"),
    ).toBe("/var/lib/t3/.codex/generated_images/abc/call_x.png");
    expect(normalizeLocalMarkdownImageSrc("file:///tmp/chart.png")).toBe("/tmp/chart.png");
    expect(
      normalizeLocalMarkdownImageSrc(
        "attachment:/var/lib/t3/.codex/generated_images/abc/call_x.png",
      ),
    ).toBe("/var/lib/t3/.codex/generated_images/abc/call_x.png");
    expect(
      isLocalMarkdownImageSrc("attachment:/var/lib/t3/.codex/generated_images/abc/call_x.png"),
    ).toBe(true);
  });

  it("detects host generated_images paths as local", () => {
    expect(
      isLocalMarkdownImageSrc("/var/lib/t3/.codex/generated_images/019f6511/call_5K1Kc.png"),
    ).toBe(true);
    expect(isLocalMarkdownImageSrc("https://cdn.example.com/a.png")).toBe(false);
    expect(isLocalMarkdownImageSrc("data:image/png;base64,abc")).toBe(false);
  });
});
