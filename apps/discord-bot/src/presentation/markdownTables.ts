/**
 * Detect GFM pipe tables in assistant text.
 * Discord does not render markdown tables; long or table-heavy finals are
 * attached as response.md instead of ASCII tableification.
 */

export interface TableMatch {
  /** Inclusive start offset of the matched source span. */
  readonly start: number;
  /** Exclusive end offset of the matched source span. */
  readonly end: number;
  /** Original matched text (may include surrounding code fences). */
  readonly raw: string;
  readonly headers: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
}

/** Split a markdown table row into cells on unescaped `|`. */
export function splitTableCells(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "|") {
      cells.push(unescapeTableCell(current.trim()));
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(unescapeTableCell(current.trim()));
  return cells;
}

function unescapeTableCell(value: string): string {
  return value
    .replace(/\\([\\|`*_{}[\]()#+\-.!])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when every cell looks like a GFM separator segment (`---`, `:---:`, etc.). */
export function isSeparatorRow(cells: ReadonlyArray<string>): boolean {
  if (cells.length === 0) return false;
  return cells.every((cell) => /^:?-{1,}:?$/.test(cell.replace(/\s+/g, "")));
}

function isTableRowLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  if (!trimmed.includes("|")) return false;
  if (trimmed.startsWith("```")) return false;
  return true;
}

function normalizeRow(cells: ReadonlyArray<string>, columnCount: number): string[] {
  const row = cells.slice(0, columnCount).map((cell) => cell);
  while (row.length < columnCount) row.push("");
  return row;
}

function tryParseTableLines(
  lines: ReadonlyArray<string>,
  startIndex: number,
): {
  readonly endIndex: number;
  readonly headers: string[];
  readonly rows: string[][];
} | null {
  if (startIndex + 1 >= lines.length) return null;
  const headerLine = lines[startIndex] ?? "";
  const separatorLine = lines[startIndex + 1] ?? "";
  if (!isTableRowLine(headerLine) || !isTableRowLine(separatorLine)) return null;

  const headers = splitTableCells(headerLine);
  const separatorCells = splitTableCells(separatorLine);
  if (headers.length === 0 || !isSeparatorRow(separatorCells)) return null;
  // Require ≥2 columns so bash/prose like `| note` + `|---` is not treated as a table.
  if (headers.length < 2 || separatorCells.length < 2) return null;
  // Separator column count should roughly match the header (allow off-by-one).
  if (Math.abs(headers.length - separatorCells.length) > 1) return null;

  const columnCount = Math.max(headers.length, separatorCells.length);
  const normalizedHeaders = normalizeRow(headers, columnCount);
  const rows: string[][] = [];
  let endIndex = startIndex + 1;

  for (let index = startIndex + 2; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!isTableRowLine(line)) break;
    const cells = splitTableCells(line);
    if (isSeparatorRow(cells)) break;
    rows.push(normalizeRow(cells, columnCount));
    endIndex = index;
  }

  if (rows.length === 0) return null;
  return { endIndex, headers: normalizedHeaders, rows };
}

/** Exclusive end offset for `lineIndex`, including its trailing newline when present. */
function lineEndExclusive(
  text: string,
  lineStarts: ReadonlyArray<number>,
  lines: ReadonlyArray<string>,
  lineIndex: number,
): number {
  const start = lineStarts[lineIndex] ?? 0;
  const line = lines[lineIndex] ?? "";
  const after = start + line.length;
  if (after < text.length && text[after] === "\r" && text[after + 1] === "\n") {
    return after + 2;
  }
  if (after < text.length && text[after] === "\n") {
    return after + 1;
  }
  return after;
}

/**
 * Find GFM pipe tables in `text`.
 * Also matches tables wrapped in fenced code blocks (``` / ```bash / etc.).
 */
export function extractMarkdownTables(text: string): TableMatch[] {
  const matches: TableMatch[] = [];
  const lineStarts: number[] = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") lineStarts.push(index + 1);
  }
  const lines = text.split(/\r?\n/);

  let lineIndex = 0;
  while (lineIndex < lines.length) {
    const line = lines[lineIndex] ?? "";
    const fenceOpen = line.match(/^(\s*)```([\w+-]*)\s*$/);
    if (fenceOpen) {
      const openIndex = lineIndex;
      let closeIndex = -1;
      for (let probe = lineIndex + 1; probe < lines.length; probe += 1) {
        if (/^\s*```\s*$/.test(lines[probe] ?? "")) {
          closeIndex = probe;
          break;
        }
      }
      if (closeIndex === -1) {
        lineIndex += 1;
        continue;
      }

      // Skip leading blank lines inside the fence.
      let tableStart = openIndex + 1;
      while (tableStart < closeIndex && (lines[tableStart] ?? "").trim() === "") {
        tableStart += 1;
      }
      const parsed = tryParseTableLines(lines, tableStart);
      if (parsed !== null) {
        let afterTable = parsed.endIndex + 1;
        while (afterTable < closeIndex && (lines[afterTable] ?? "").trim() === "") {
          afterTable += 1;
        }
        if (afterTable === closeIndex) {
          const start = lineStarts[openIndex] ?? 0;
          const exclusiveEnd = lineEndExclusive(text, lineStarts, lines, closeIndex);
          matches.push({
            start,
            end: exclusiveEnd,
            raw: text.slice(start, exclusiveEnd),
            headers: parsed.headers,
            rows: parsed.rows,
          });
          lineIndex = closeIndex + 1;
          continue;
        }
      }
      lineIndex = closeIndex + 1;
      continue;
    }

    const parsed = tryParseTableLines(lines, lineIndex);
    if (parsed === null) {
      lineIndex += 1;
      continue;
    }

    const start = lineStarts[lineIndex] ?? 0;
    const exclusiveEnd = lineEndExclusive(text, lineStarts, lines, parsed.endIndex);
    matches.push({
      start,
      end: exclusiveEnd,
      raw: text.slice(start, exclusiveEnd),
      headers: parsed.headers,
      rows: parsed.rows,
    });
    lineIndex = parsed.endIndex + 1;
  }

  return matches;
}

/** True when `text` contains at least one GFM pipe table. */
export function hasMarkdownTables(text: string): boolean {
  return extractMarkdownTables(text).length > 0;
}
