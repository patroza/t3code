import { describe, expect, it } from "vite-plus/test";

import {
  extractMarkdownTables,
  hasMarkdownTables,
  isSeparatorRow,
  splitTableCells,
} from "./markdownTables.ts";

describe("splitTableCells", () => {
  it("splits on unescaped pipes and trims cells", () => {
    expect(splitTableCells("| Doc | What it is |")).toEqual(["Doc", "What it is"]);
    expect(splitTableCells("Doc | What it is")).toEqual(["Doc", "What it is"]);
  });

  it("keeps escaped pipes inside a cell", () => {
    expect(splitTableCells("| a \\| b | c |")).toEqual(["a | b", "c"]);
  });
});

describe("isSeparatorRow", () => {
  it("accepts GFM separator cells", () => {
    expect(isSeparatorRow(["---", ":---", "---:", ":---:"])).toBe(true);
    expect(isSeparatorRow(["Doc", "What"])).toBe(false);
  });
});

describe("extractMarkdownTables", () => {
  it("extracts a short unfenced table", () => {
    const text = `| Doc | What it actually is |
|---|---|
| effect-cluster-worker-migration.md | Mixed topology notes. |
| durable-print-roundtrip.md | EasyLife workflow. |`;

    const matches = extractMarkdownTables(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.headers).toEqual(["Doc", "What it actually is"]);
    expect(matches[0]?.rows).toEqual([
      ["effect-cluster-worker-migration.md", "Mixed topology notes."],
      ["durable-print-roundtrip.md", "EasyLife workflow."],
    ]);
    expect(matches[0]?.start).toBe(0);
    expect(matches[0]?.end).toBe(text.length);
  });

  it("extracts a table wrapped in a code fence", () => {
    const text = `\`\`\`bash
| Doc | What |
|---|---|
| a.md | first |
\`\`\``;
    const matches = extractMarkdownTables(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.headers).toEqual(["Doc", "What"]);
    expect(matches[0]?.rows).toEqual([["a.md", "first"]]);
    expect(matches[0]?.raw.startsWith("```")).toBe(true);
  });

  it("finds a table with surrounding prose", () => {
    const text = `Intro line.

| A | B |
|---|---|
| 1 | 2 |

Outro line.`;
    const matches = extractMarkdownTables(text);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.headers).toEqual(["A", "B"]);
    expect(text.slice(0, matches[0]!.start)).toContain("Intro");
    expect(text.slice(matches[0]!.end)).toContain("Outro");
  });

  it("returns empty when there is no table", () => {
    expect(extractMarkdownTables("just a paragraph\nand another")).toEqual([]);
    expect(extractMarkdownTables("| not a table without separator |")).toEqual([]);
  });
});

describe("hasMarkdownTables", () => {
  it("is true when a pipe table is present", () => {
    expect(
      hasMarkdownTables(`| A | B |
|---|---|
| 1 | 2 |`),
    ).toBe(true);
  });

  it("is false for ordinary prose", () => {
    expect(hasMarkdownTables("Short reply without tables.")).toBe(false);
  });
});
