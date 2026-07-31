import { describe, expect, it } from "vite-plus/test";

import {
  chunkDiscordContentPreservingTables,
  extractMarkdownTables,
  isSeparatorRow,
  renderMysqlTable,
  renderRoundedTable,
  rewriteMarkdownTablesForDiscord,
  splitTableCells,
  wrapCellText,
} from "./asciiTables.ts";

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

describe("wrapCellText", () => {
  it("wraps on word boundaries", () => {
    expect(wrapCellText("hello world friend", 10)).toEqual(["hello", "world", "friend"]);
    expect(wrapCellText("short", 60)).toEqual(["short"]);
  });

  it("hard-breaks overlong tokens", () => {
    expect(wrapCellText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
});

describe("renderRoundedTable", () => {
  it("renders a short aligned rounded table", () => {
    const rendered = renderRoundedTable(
      ["Col1", "Col2"],
      [
        ["Value 1", "Value 2"],
        ["x", "y"],
      ],
    );
    expect(rendered).toBe(
      [
        ".---------.---------.",
        "| Col1    | Col2    |",
        ":---------+---------:",
        "| Value 1 | Value 2 |",
        ":---------+---------:",
        "| x       | y       |",
        "'---------'---------'",
      ].join("\n"),
    );
  });

  it("wraps a long-description column within the Discord line width cap", () => {
    const long =
      "Incomplete — only inbound SFTP settle window (10s). Missing ABAS create/fetch delivery note.";
    const rendered = renderRoundedTable(
      ["Doc", "What it actually is"],
      [["abas-file-handoff.md", long]],
      40,
      72,
    );
    const lines = rendered.split("\n");
    // Multi-line body row for the wrapped description.
    const bodyLines = lines.filter((line) => line.startsWith("|"));
    expect(bodyLines.length).toBeGreaterThan(2); // header + at least 2 wrapped body lines
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(72);
    }
    expect(rendered).toContain("abas-file-handoff.md");
    expect(rendered).toContain("Incomplete");
    expect(rendered.startsWith(".")).toBe(true);
    expect(rendered.endsWith("'")).toBe(true);
  });

  it("right-aligns mostly-numeric columns", () => {
    const rendered = renderRoundedTable(
      ["Name", "Amount"],
      [
        ["a", "10.0"],
        ["b", "-2,027.1"],
      ],
    );
    expect(rendered).toContain("|     10.0 |");
    expect(rendered).toContain("| -2,027.1 |");
  });
});

describe("renderMysqlTable", () => {
  it("uses +---+ box borders with a separator after every row", () => {
    const rendered = renderMysqlTable(
      ["H1", "H2"],
      [
        ["a", "b"],
        ["c", "d"],
      ],
    );
    expect(rendered).toBe(
      [
        "+----+----+",
        "| H1 | H2 |",
        "+----+----+",
        "| a  | b  |",
        "+----+----+",
        "| c  | d  |",
        "+----+----+",
      ].join("\n"),
    );
  });
});

describe("rewriteMarkdownTablesForDiscord", () => {
  it("rewrites a short table to a fenced rounded ASCII table", () => {
    const input = `| Doc | What |
|---|---|
| a.md | first |`;
    const result = rewriteMarkdownTablesForDiscord(input);
    expect(result.attachments).toEqual([]);
    expect(result.text.startsWith("```\n")).toBe(true);
    expect(result.text.endsWith("\n```")).toBe(true);
    expect(result.text).toContain("| Doc ");
    expect(result.text).toContain("| a.md");
    expect(result.text).toContain(".---");
  });

  it("preserves surrounding text", () => {
    const input = `Before.

| A | B |
|---|---|
| 1 | 2 |

After.`;
    const result = rewriteMarkdownTablesForDiscord(input);
    expect(result.text.startsWith("Before.")).toBe(true);
    expect(result.text.endsWith("After.")).toBe(true);
    expect(result.text).toContain("```");
    expect(result.text).not.toContain("|---|");
  });

  it("is a passthrough when there is no table", () => {
    const input = "No tables here, just prose.";
    expect(rewriteMarkdownTablesForDiscord(input)).toEqual({
      text: input,
      attachments: [],
    });
  });

  it("replaces fenced markdown tables", () => {
    const input = `\`\`\`bash
| Doc | What |
|---|---|
| a.md | first |
\`\`\``;
    const result = rewriteMarkdownTablesForDiscord(input);
    expect(result.text).not.toContain("```bash");
    expect(result.text).toContain("| Doc ");
    expect(result.attachments).toEqual([]);
  });

  it("keeps long-text multi-row content in a single table", () => {
    const input = `| Doc | What it actually is |
|---|---|
| effect-cluster-worker-migration.md | Mixed: some current topology (shard groups, storage protocols) plus cutover history, removed files, bug notes (void RPC), follow-ups. Title/index still read as migration, not the living ops reference. EasyLife-centric. |
| durable-print-roundtrip.md | EasyLife workflow round-trip (activities, keys, pack SM). Not deploy/runtime/poll/alerts. |
| abas-file-handoff.md | Incomplete — only inbound SFTP settle window (10s). Missing ABAS create/fetch delivery note, packaging import, closeout CSV write, mounts, who runs where. |
| packstations-and-printers.md | Printer ids / CUPS naming / company maps. Not cluster mailbox model. |`;
    const result = rewriteMarkdownTablesForDiscord(input);
    expect(result.attachments).toEqual([]);
    // One table, one fence — do not split into one mini-table per row.
    expect(result.text.match(/```/g)?.length).toBe(2);
    expect(result.text.startsWith("```\n")).toBe(true);
    expect(result.text.endsWith("\n```")).toBe(true);
    expect(result.text).not.toContain("\u200B");
    // Only one header block / top border (not one mini-table per row).
    const pipeLines = result.text.split("\n").filter((line) => line.startsWith("|"));
    expect(pipeLines.filter((line) => line.includes("What it actually is")).length).toBe(1);
    expect(result.text.split("\n").filter((line) => line.startsWith(".")).length).toBe(1);
    expect(result.text).toContain("EasyLife-centric.");
    expect(result.text).toContain("effect-cluster-worker-migration.md");
    expect(result.text).toContain("packstations-and-printers.md");
    for (const line of result.text.split("\n")) {
      if (
        line.startsWith("|") ||
        line.startsWith(".") ||
        line.startsWith(":") ||
        line.startsWith("'")
      ) {
        expect(line.length).toBeLessThanOrEqual(72);
      }
    }
  });

  it("attaches a single row only when it still exceeds the message limit", () => {
    const huge = "word ".repeat(500).trim();
    const input = ["| Col | Description |", "|---|---|", `| only | ${huge} |`].join("\n");
    const result = rewriteMarkdownTablesForDiscord(input, {
      messageLimit: 200,
      maxColWidth: 40,
      maxTableWidth: 72,
    });
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0]?.name).toBe("table.txt");
    expect(result.attachments[0]?.body).toContain("word");
    expect(result.text).toContain("table.txt");
  });

  it("right-aligns a numeric column wider than its header", () => {
    const rendered = renderRoundedTable(
      ["Name", "Amount"],
      [
        ["a", "10.0"],
        ["b", "-2,027.1"],
        ["c", "1,234,567.89"],
      ],
    );
    expect(rendered).toContain("| Name |       Amount |");
    expect(rendered).toContain("| a    |         10.0 |");
    expect(rendered).toContain("| b    |     -2,027.1 |");
    expect(rendered).toContain("| c    | 1,234,567.89 |");
  });

  it("does not convert a fenced bash block that only looks a bit like a table", () => {
    const input = `\`\`\`bash
| not a real table without separator style
|---
echo "hello | world"
\`\`\``;
    const result = rewriteMarkdownTablesForDiscord(input);
    expect(result.attachments).toEqual([]);
    expect(result.text).toBe(input);
    expect(extractMarkdownTables(input)).toEqual([]);
  });

  it("names dual oversized table attachments in document reading order", () => {
    const huge = "word ".repeat(400).trim();
    const input = [
      "| ColA | DescA |",
      "|---|---|",
      `| first-table | ${huge} |`,
      "",
      "Some prose between.",
      "",
      "| ColB | DescB |",
      "|---|---|",
      `| second-table | ${huge} |`,
    ].join("\n");
    const result = rewriteMarkdownTablesForDiscord(input, {
      messageLimit: 300,
      maxColWidth: 40,
      maxTableWidth: 72,
    });
    expect(result.attachments.map((entry) => entry.name)).toEqual(["table-1.txt", "table-2.txt"]);
    expect(result.attachments[0]?.body).toContain("first-table");
    expect(result.attachments[1]?.body).toContain("second-table");
    // Notes in body follow the same reading order.
    const firstNote = result.text.indexOf("table-1.txt");
    const secondNote = result.text.indexOf("table-2.txt");
    expect(firstNote).toBeGreaterThanOrEqual(0);
    expect(secondNote).toBeGreaterThan(firstNote);
    expect(result.text.indexOf("first-table")).toBe(-1);
    expect(result.text.indexOf("second-table")).toBe(-1);
  });
});

describe("chunkDiscordContentPreservingTables", () => {
  it("does not split inside a fenced ASCII table", () => {
    const table = [
      "```",
      ".----+----.",
      "| A  | B  |",
      ":----+----:",
      "| 1  | 2  |",
      "'----+----'",
      "```",
    ].join("\n");
    // Force a second chunk: large prose + full fenced table > limit.
    const prefix = "x".repeat(1950);
    const text = `${prefix}\n\n${table}`;
    expect(text.length).toBeGreaterThan(2000);
    const chunks = chunkDiscordContentPreservingTables(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    const withTable = chunks.find((chunk) => chunk.includes(".----+----."));
    expect(withTable).toBeDefined();
    expect(withTable).toContain("'----+----'");
    expect(withTable).toContain("```");
    // Fence must stay contiguous in one chunk.
    expect(withTable?.indexOf("```")).toBeLessThan(withTable!.lastIndexOf("```"));
  });
});
