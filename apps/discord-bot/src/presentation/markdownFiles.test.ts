import { describe, expect, it } from "vite-plus/test";

import {
  extractMarkdownLocalFileLinks,
  fileNameForLocalFileRef,
  guessFileMimeType,
  isLocalFileSrc,
  replaceMarkdownLocalFileLinks,
  stripMarkdownLocalFileLinks,
} from "./markdownFiles.ts";

const SAMPLE_CSV_PATH = "/tmp/carrier_usage/label_ops_proxy.csv";

describe("extractMarkdownLocalFileLinks", () => {
  it("parses local csv markdown links", () => {
    const text = `And the extracted table here:
[label_ops_proxy.csv](${SAMPLE_CSV_PATH})`;
    const files = extractMarkdownLocalFileLinks(text);
    expect(files).toHaveLength(1);
    expect(files[0]?.src).toBe(SAMPLE_CSV_PATH);
    expect(files[0]?.label).toBe("label_ops_proxy.csv");
  });

  it("parses local file links with line numbers", () => {
    const text = `[githubLinks.ts](/tmp/project/githubLinks.ts:96)`;
    const files = extractMarkdownLocalFileLinks(text);
    expect(files).toHaveLength(1);
    expect(files[0]?.src).toBe("/tmp/project/githubLinks.ts");
    expect(files[0]?.target).toBe("/tmp/project/githubLinks.ts:96");
  });

  it("ignores http links and local image links", () => {
    const text = `
[report.csv](https://example.com/report.csv)
[graph.png](/tmp/carrier_usage/graph.png)
`;
    expect(extractMarkdownLocalFileLinks(text)).toEqual([]);
  });
});

describe("stripMarkdownLocalFileLinks", () => {
  it("removes local file links but keeps surrounding prose", () => {
    const text = `I saved the file here:

[label_ops_proxy.csv](<${SAMPLE_CSV_PATH}>)

Use it if you need exact counts.`;
    const stripped = stripMarkdownLocalFileLinks(text);
    expect(stripped).not.toContain("label_ops_proxy.csv](");
    expect(stripped).toContain("I saved the file here:");
    expect(stripped).toContain("Use it if you need exact counts.");
  });

  it("can replace local file links with readable attached markers", () => {
    const text = `I saved the file here:

[label_ops_proxy.csv](<${SAMPLE_CSV_PATH}>)`;
    const replaced = replaceMarkdownLocalFileLinks(text, (ref) => `${ref.label} (attached below)`);
    expect(replaced).toContain("I saved the file here:");
    expect(replaced).toContain("label_ops_proxy.csv (attached below)");
    expect(replaced).not.toContain("](");
  });
});

describe("local file helpers", () => {
  it("detects attachment: and relative local files", () => {
    expect(isLocalFileSrc(`attachment:${SAMPLE_CSV_PATH}`)).toBe(true);
    expect(isLocalFileSrc("./artifacts/table.csv")).toBe(true);
    expect(isLocalFileSrc("https://example.com/table.csv")).toBe(false);
  });

  it("uses the visible label for the Discord attachment name", () => {
    const ref = extractMarkdownLocalFileLinks(`[carrier data](${SAMPLE_CSV_PATH})`)[0];
    expect(ref).toBeDefined();
    expect(fileNameForLocalFileRef(ref!)).toBe("carrier_data.csv");
  });

  it("guesses csv mime types", () => {
    expect(guessFileMimeType(SAMPLE_CSV_PATH)).toBe("text/plain;charset=utf-8");
    expect(guessFileMimeType("/tmp/data.json")).toBe("text/plain;charset=utf-8");
  });

  it("uses native media types for audio and video previews", () => {
    expect(guessFileMimeType("/tmp/clip.mp4")).toBe("video/mp4");
    expect(guessFileMimeType("/tmp/voice.mp3")).toBe("audio/mpeg");
  });
});
