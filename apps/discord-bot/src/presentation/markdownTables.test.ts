import { describe, expect, it } from "vite-plus/test";

import {
  extractMarkdownTables,
  hasMarkdownTables,
  isSeparatorRow,
  renderTableAsBullets,
  rewriteMarkdownTablesForDiscord,
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
  });

  it("extracts a table wrapped in a code fence", () => {
    const text = `\`\`\`md
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

  it("returns empty when there is no complete table", () => {
    expect(extractMarkdownTables("just a paragraph\nand another")).toEqual([]);
    expect(extractMarkdownTables("| not a table without separator |")).toEqual([]);
  });

  it("requires at least two columns", () => {
    const text = `| Note |
|---|
| only |`;
    expect(extractMarkdownTables(text)).toEqual([]);
  });
});

describe("renderTableAsBullets", () => {
  it("formats two-column tables as labeled bullets", () => {
    expect(
      renderTableAsBullets(
        ["Piece", "Behavior"],
        [
          ["Event Hub meta", "enqueuedTimeUtc + sequenceNumber"],
          ["Logging", "Warning with order id"],
        ],
      ),
    ).toBe(
      [
        "- **Event Hub meta:** enqueuedTimeUtc + sequenceNumber",
        "- **Logging:** Warning with order id",
      ].join("\n"),
    );
  });

  it("formats wider tables with header labels per field", () => {
    expect(
      renderTableAsBullets(
        ["Name", "Amount", "Unit"],
        [
          ["a", "10", "kg"],
          ["b", "2", "g"],
        ],
      ),
    ).toBe(
      [
        "- **Name:** a · **Amount:** 10 · **Unit:** kg",
        "- **Name:** b · **Amount:** 2 · **Unit:** g",
      ].join("\n"),
    );
  });
});

describe("rewriteMarkdownTablesForDiscord", () => {
  it("rewrites a short table to bullets and drops pipe syntax", () => {
    const input = `| Doc | What |
|---|---|
| a.md | first |`;
    const result = rewriteMarkdownTablesForDiscord(input);
    expect(result).toBe("- **a.md:** first");
    expect(result).not.toContain("|");
    expect(result).not.toContain("---");
  });

  it("preserves surrounding text", () => {
    const input = `Before.

| A | B |
|---|---|
| 1 | 2 |

After.`;
    const result = rewriteMarkdownTablesForDiscord(input);
    expect(result.startsWith("Before.")).toBe(true);
    expect(result.endsWith("After.")).toBe(true);
    expect(result).toContain("- **1:** 2");
    expect(result).not.toContain("|---|");
  });

  it("is a passthrough when there is no table", () => {
    const input = "No tables here, just prose.";
    expect(rewriteMarkdownTablesForDiscord(input)).toBe(input);
  });

  it("replaces fenced markdown tables", () => {
    const input = `\`\`\`md
| Doc | What |
|---|---|
| a.md | first |
\`\`\``;
    const result = rewriteMarkdownTablesForDiscord(input);
    expect(result).not.toContain("```");
    expect(result).toBe("- **a.md:** first");
  });

  it("hasMarkdownTables tracks complete tables only", () => {
    expect(hasMarkdownTables("| Doc | What |\n|---|---|\n| a | b |")).toBe(true);
    expect(hasMarkdownTables("no table")).toBe(false);
  });
});
