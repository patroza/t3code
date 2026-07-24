// @effect-diagnostics nodeBuiltinImport:off
import { describe, expect, it } from "vite-plus/test";

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  assertFilesystemPath,
  extractMarkdownImages,
  fileNameForImageRef,
  isLocalImageSrc,
  normalizeLocalImagePath,
  resolveImagePathOnDisk,
  stripMarkdownImages,
} from "./markdownImages.ts";

const SAMPLE_PATH =
  "/var/lib/t3/.codex/generated_images/019f6511-7b93-7663-9908-41e3f45b5bac/call_5K1KcXmRdTGulQT91c2PtIl6.png";

describe("extractMarkdownImages", () => {
  it("parses markdown images with angle brackets", () => {
    const text = `![EasyLife](</var/lib/t3/.codex/generated_images/abc/call_xyz.png>)`;
    const images = extractMarkdownImages(text);
    expect(images).toHaveLength(1);
    expect(images[0]?.src).toContain("generated_images");
    expect(images[0]?.src.startsWith("attachment:")).toBe(false);
  });

  it("parses HTML img tags like Discord screenshot", () => {
    const text = `<img src="${SAMPLE_PATH}" alt="EasyLife weekday activity estimate graph" />

I can't force this client to inline a local filesystem image.`;
    const images = extractMarkdownImages(text);
    expect(images).toHaveLength(1);
    expect(images[0]?.src).toBe(SAMPLE_PATH);
    expect(images[0]?.alt).toContain("EasyLife");
    const stripped = stripMarkdownImages(text);
    expect(stripped).not.toContain("<img");
    expect(stripped).not.toContain(SAMPLE_PATH);
    expect(stripped).toContain("can't force");
  });

  it("parses markdown links to local image files", () => {
    const text = `The image file is here:

[call_5K1KcXmRdTGulQT91c2PtIl6.png](<${SAMPLE_PATH}>)

If you want, I can regenerate it.`;
    const images = extractMarkdownImages(text);
    expect(images).toHaveLength(1);
    expect(images[0]?.src).toBe(SAMPLE_PATH);
    const stripped = stripMarkdownImages(text);
    expect(stripped).not.toContain("call_5K1Kc");
    expect(stripped).toContain("If you want");
  });

  it("extracts both html img and md link from the same message", () => {
    const text = `<img src="${SAMPLE_PATH}" alt="EasyLife graph" />

I can't force this client.

[call_5K1KcXmRdTGulQT91c2PtIl6.png](<${SAMPLE_PATH}>)

Regenerate?`;
    const images = extractMarkdownImages(text);
    // Same path twice is fine — load once by src key; extract may return both embeds
    expect(images.length).toBeGreaterThanOrEqual(1);
    expect(images.every((i) => i.src === SAMPLE_PATH)).toBe(true);
    const stripped = stripMarkdownImages(text);
    expect(stripped).not.toContain("<img");
    expect(stripped).not.toContain(SAMPLE_PATH);
  });

  it("strips attachment: completely", () => {
    expect(normalizeLocalImagePath(`attachment:${SAMPLE_PATH}`)).toBe(SAMPLE_PATH);
    expect(assertFilesystemPath(`attachment:${SAMPLE_PATH}`)).toBe(SAMPLE_PATH);
    expect(isLocalImageSrc(`attachment:${SAMPLE_PATH}`)).toBe(true);
  });

  it("extracts attachment: markdown images", () => {
    const text = `![EasyLife](attachment:${SAMPLE_PATH})`;
    const images = extractMarkdownImages(text);
    expect(images).toHaveLength(1);
    expect(images[0]?.src).toBe(SAMPLE_PATH);
    // Prefer human alt for Discord attachment name (image preview still uses .png).
    expect(fileNameForImageRef(images[0]!)).toBe("EasyLife.png");
  });

  it("falls back to path basename when alt is empty", () => {
    const text = `![](${SAMPLE_PATH})`;
    const images = extractMarkdownImages(text);
    expect(images).toHaveLength(1);
    expect(fileNameForImageRef(images[0]!)).toBe("call_5K1KcXmRdTGulQT91c2PtIl6.png");
  });

  it("treats Grok session-relative images/1.jpg as a local image", () => {
    const text = `Here’s a soft blush peony:\n\n![Beautiful flower](images/1.jpg)\n`;
    const images = extractMarkdownImages(text);
    expect(images).toHaveLength(1);
    expect(images[0]?.src).toBe("images/1.jpg");
    expect(fileNameForImageRef(images[0]!)).toBe("Beautiful_flower.jpg");
  });
});

describe("resolveImagePathOnDisk", () => {
  it("resolves Grok session-relative images under a sessions tree", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mdimg-"));
    const sessionImages = NodePath.join(root, "encoded-cwd", "session-id", "images");
    NodeFS.mkdirSync(sessionImages, { recursive: true });
    const absolute = NodePath.join(sessionImages, "1.jpg");
    NodeFS.writeFileSync(absolute, Buffer.from([0xff, 0xd8, 0xff, 0xd9])); // minimal jpeg-ish

    // Point search at our temp root by temporarily resolving via absolute path existence first.
    expect(resolveImagePathOnDisk(absolute)).toBe(absolute);

    // Relative form: only finds files under HOME/.grok/sessions in prod. For unit coverage,
    // verify absolute + cwd cases; relative search is integration-tested on the guest.
    const cwdRel = NodePath.join(root, "images");
    NodeFS.mkdirSync(cwdRel, { recursive: true });
    const cwdFile = NodePath.join(cwdRel, "2.png");
    NodeFS.writeFileSync(cwdFile, Buffer.from([1, 2, 3]));
    const prev = process.cwd();
    try {
      process.chdir(root);
      expect(resolveImagePathOnDisk("images/2.png")).toBe(cwdFile);
    } finally {
      process.chdir(prev);
    }
  });
});
