/**
 * Convert GFM pipe tables into aligned ASCII tables for Discord.
 * Discord does not render markdown tables, so monospace box drawing is required.
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

export interface DiscordTableAttachment {
  readonly name: string;
  readonly body: string;
}

export interface RewriteMarkdownTablesResult {
  readonly text: string;
  readonly attachments: ReadonlyArray<DiscordTableAttachment>;
}

export type AsciiTableStyle = "rounded" | "mysql";

/** Per-column wrap width before word-break. Kept modest for Discord code blocks. */
const DEFAULT_MAX_COL_WIDTH = 40;
/**
 * Hard cap on a single rendered table line (borders included).
 * Wider lines soft-wrap in Discord clients and destroy alignment.
 */
const DEFAULT_MAX_TABLE_WIDTH = 72;
const DEFAULT_MESSAGE_LIMIT = 2000;

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
  // Require a pipe that actually separates content (not a lone `|`).
  if (!trimmed.includes("|")) return false;
  // Reject pure fence markers.
  if (/^```/.test(trimmed)) return false;
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
    // A second separator row ends the table (defensive).
    if (isSeparatorRow(cells)) break;
    // Blank-looking pipe rows still count as data.
    rows.push(normalizeRow(cells, columnCount));
    endIndex = index;
  }

  if (rows.length === 0) return null;
  return { endIndex, headers: normalizedHeaders, rows };
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

      const innerStart = openIndex + 1;
      // Skip leading blank lines inside the fence.
      let tableStart = innerStart;
      while (tableStart < closeIndex && (lines[tableStart] ?? "").trim() === "") {
        tableStart += 1;
      }
      const parsed = tryParseTableLines(lines, tableStart);
      if (parsed !== null) {
        // Trailing blank lines after the table before the closing fence are ok.
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

/** Exclusive end offset for `lineIndex`, including its trailing newline when present. */
function lineEndExclusive(
  text: string,
  lineStarts: ReadonlyArray<number>,
  lines: ReadonlyArray<string>,
  lineIndex: number,
): number {
  const start = lineStarts[lineIndex] ?? text.length;
  const line = lines[lineIndex] ?? "";
  let exclusiveEnd = start + line.length;
  if (exclusiveEnd < text.length && (text[exclusiveEnd] === "\n" || text[exclusiveEnd] === "\r")) {
    exclusiveEnd =
      text[exclusiveEnd] === "\r" && text[exclusiveEnd + 1] === "\n"
        ? exclusiveEnd + 2
        : exclusiveEnd + 1;
  }
  return exclusiveEnd;
}

/** Wrap cell text to maxWidth, preferring spaces then hyphens over hard cuts. */
export function wrapCellText(text: string, maxWidth: number): string[] {
  const width = Math.max(1, maxWidth);
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return [""];
  if (normalized.length <= width) return [normalized];

  const lines: string[] = [];
  let remaining = normalized;
  while (remaining.length > width) {
    let breakAt = remaining.lastIndexOf(" ", width);
    if (breakAt <= 0) {
      // Soft-break filenames / dotted identifiers on '-' or '_' / '.'.
      const hyphen = remaining.lastIndexOf("-", width);
      const under = remaining.lastIndexOf("_", width);
      const dot = remaining.lastIndexOf(".", width);
      breakAt = Math.max(hyphen, under, dot);
      if (breakAt <= 0) breakAt = width;
      else breakAt += 1; // keep the separator on the left line
    }
    lines.push(remaining.slice(0, breakAt).trimEnd());
    remaining = remaining.slice(breakAt).trimStart();
  }
  if (remaining.length > 0) lines.push(remaining);
  return lines.length > 0 ? lines : [""];
}

/** Longest token that prefers not to wrap (whole cell if no spaces). */
function preferredMinCellWidth(cell: string, maxColWidth: number): number {
  const normalized = cell.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return 1;
  if (!/\s/.test(normalized)) {
    return Math.min(maxColWidth, normalized.length);
  }
  let longest = 1;
  for (const word of normalized.split(" ")) {
    longest = Math.max(longest, Math.min(maxColWidth, word.length));
  }
  return longest;
}

function padCell(text: string, width: number, align: "left" | "right" = "left"): string {
  const clipped = text.length > width ? text.slice(0, width) : text;
  if (align === "right") {
    return clipped.padStart(width, " ");
  }
  return clipped.padEnd(width, " ");
}

function looksNumeric(value: string): boolean {
  if (value.trim() === "") return false;
  // Numbers, optional thousands separators, decimals, leading sign.
  return /^-?[\d,]+(?:\.\d+)?%?$/.test(value.trim());
}

function columnAlignments(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): Array<"left" | "right"> {
  return headers.map((_, col) => {
    const values = rows.map((row) => row[col] ?? "").filter((value) => value.trim() !== "");
    if (values.length === 0) return "left";
    return values.every(looksNumeric) ? "right" : "left";
  });
}

/** Total monospace width of a table line for the given column widths. */
export function tableLineWidth(widths: ReadonlyArray<number>): number {
  if (widths.length === 0) return 0;
  // `| ${cell} | ${cell} |` → sum(width + 2) + (n + 1) pipe chars = sum(widths) + 3n + 1
  return widths.reduce((sum, width) => sum + width, 0) + 3 * widths.length + 1;
}

/**
 * Shrink column widths so the full table line stays within maxTableWidth.
 * Prefer shrinking prose columns (spaces) before identifier columns.
 */
export function fitColumnWidthsToTableWidth(
  widths: ReadonlyArray<number>,
  maxTableWidth: number,
  minWidths?: ReadonlyArray<number>,
): number[] {
  const next = widths.map((width) => Math.max(1, width));
  if (next.length === 0) return next;
  const mins =
    minWidths?.map((width, index) => Math.max(1, Math.min(next[index] ?? 1, width))) ??
    next.map(() => 1);
  // Minimum usable line width with mins (or 1s).
  const minLine = tableLineWidth(mins);
  const budget = Math.max(minLine, maxTableWidth);

  while (tableLineWidth(next) > budget) {
    // Prefer columns that are above their preferred min, then the widest.
    let victim = -1;
    for (let index = 0; index < next.length; index += 1) {
      const width = next[index] ?? 1;
      const floor = mins[index] ?? 1;
      if (width <= floor) continue;
      if (
        victim === -1 ||
        width > (next[victim] ?? 0) ||
        (width === (next[victim] ?? 0) && floor < (mins[victim] ?? 1))
      ) {
        victim = index;
      }
    }
    if (victim === -1) {
      // Forced below preferred mins to meet budget.
      let longest = 0;
      for (let index = 1; index < next.length; index += 1) {
        if ((next[index] ?? 0) > (next[longest] ?? 0)) longest = index;
      }
      if ((next[longest] ?? 1) <= 1) break;
      next[longest] = (next[longest] ?? 1) - 1;
      continue;
    }
    next[victim] = (next[victim] ?? 1) - 1;
  }
  return next;
}

function computeColumnWidths(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  maxColWidth: number,
  maxTableWidth = DEFAULT_MAX_TABLE_WIDTH,
): number[] {
  const columnCount = headers.length;
  const widths = Array.from({ length: columnCount }, () => 1);
  const minWidths = Array.from({ length: columnCount }, () => 1);

  const consider = (cell: string, col: number) => {
    minWidths[col] = Math.max(minWidths[col] ?? 1, preferredMinCellWidth(cell, maxColWidth));
    for (const line of wrapCellText(cell, maxColWidth)) {
      widths[col] = Math.min(maxColWidth, Math.max(widths[col] ?? 1, line.length));
    }
  };

  for (let col = 0; col < columnCount; col += 1) {
    consider(headers[col] ?? "", col);
  }
  for (const row of rows) {
    for (let col = 0; col < columnCount; col += 1) {
      consider(row[col] ?? "", col);
    }
  }
  // Ideal width is at least the preferred min (e.g. full filename).
  for (let col = 0; col < columnCount; col += 1) {
    widths[col] = Math.max(widths[col] ?? 1, minWidths[col] ?? 1);
  }
  return fitColumnWidthsToTableWidth(widths, maxTableWidth, minWidths);
}

function mysqlBorder(widths: ReadonlyArray<number>, junction: "+" = "+"): string {
  return `${junction}${widths.map((width) => "-".repeat(width + 2)).join(junction)}${junction}`;
}

/**
 * Classic MySQL CLI box table (`+---+`, `|`, separator after header and each row group).
 */
export function renderMysqlTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  maxColWidth = DEFAULT_MAX_COL_WIDTH,
  maxTableWidth = DEFAULT_MAX_TABLE_WIDTH,
): string {
  if (headers.length === 0) return "";
  const widths = computeColumnWidths(headers, rows, maxColWidth, maxTableWidth);
  const alignments = columnAlignments(headers, rows);
  // Wrap against the fitted width per column (not the pre-fit maxColWidth).
  const wrapWidths = widths.map((width) => Math.min(maxColWidth, width));
  const top = mysqlBorder(widths, "+");
  const mid = mysqlBorder(widths, "+");
  const out: string[] = [top];
  out.push(...buildRowLinesFitted(headers, widths, alignments, wrapWidths));
  out.push(mid);
  for (const row of rows) {
    out.push(...buildRowLinesFitted(row, widths, alignments, wrapWidths));
    out.push(mid);
  }
  // Last mid is the bottom border — already correct with +---+ style.
  return out.join("\n");
}

function buildRowLinesFitted(
  cells: ReadonlyArray<string>,
  widths: ReadonlyArray<number>,
  alignments: ReadonlyArray<"left" | "right">,
  wrapWidths: ReadonlyArray<number>,
): string[] {
  const wrapped = cells.map((cell, index) => wrapCellText(cell, wrapWidths[index] ?? 1));
  const height = Math.max(1, ...wrapped.map((lines) => lines.length));
  const lines: string[] = [];
  for (let rowLine = 0; rowLine < height; rowLine += 1) {
    const parts = widths.map((width, col) => {
      const text = wrapped[col]?.[rowLine] ?? "";
      return ` ${padCell(text, width, alignments[col] ?? "left")} `;
    });
    lines.push(`|${parts.join("|")}|`);
  }
  return lines;
}

function roundedTop(widths: ReadonlyArray<number>): string {
  return `.${widths.map((width) => "-".repeat(width + 2)).join(".")}.`;
}

function roundedBottom(widths: ReadonlyArray<number>): string {
  return `'${widths.map((width) => "-".repeat(width + 2)).join("'")}'`;
}

function roundedSeparator(widths: ReadonlyArray<number>): string {
  return `:${widths.map((width) => "-".repeat(width + 2)).join("+")}:`;
}

/**
 * Rounded ASCII table matching the Discord-friendly style:
 * top `.---.`, separators `:---+---:` after every row, bottom `'---'`.
 */
export function renderRoundedTable(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  maxColWidth = DEFAULT_MAX_COL_WIDTH,
  maxTableWidth = DEFAULT_MAX_TABLE_WIDTH,
): string {
  if (headers.length === 0) return "";
  const widths = computeColumnWidths(headers, rows, maxColWidth, maxTableWidth);
  const alignments = columnAlignments(headers, rows);
  const wrapWidths = widths.map((width) => Math.min(maxColWidth, width));
  const out: string[] = [roundedTop(widths)];
  out.push(...buildRowLinesFitted(headers, widths, alignments, wrapWidths));
  out.push(roundedSeparator(widths));
  for (let index = 0; index < rows.length; index += 1) {
    out.push(...buildRowLinesFitted(rows[index] ?? [], widths, alignments, wrapWidths));
    if (index < rows.length - 1) {
      out.push(roundedSeparator(widths));
    }
  }
  out.push(roundedBottom(widths));
  return out.join("\n");
}

function fenceTable(body: string): string {
  return `\`\`\`\n${body}\n\`\`\``;
}

function renderTableBody(
  style: AsciiTableStyle,
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  maxColWidth: number,
  maxTableWidth: number,
): string {
  return style === "mysql"
    ? renderMysqlTable(headers, rows, maxColWidth, maxTableWidth)
    : renderRoundedTable(headers, rows, maxColWidth, maxTableWidth);
}

/** True when any cell would wrap at maxColWidth (long text → prefer one-row tables). */
export function tableHasLongCells(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  maxColWidth: number,
): boolean {
  for (const cell of headers) {
    if (cell.length > maxColWidth) return true;
  }
  for (const row of rows) {
    for (const cell of row) {
      if (cell.length > maxColWidth) return true;
    }
  }
  return false;
}

/**
 * Render a markdown table as one or more fenced ASCII tables for Discord.
 * Prefer a **single** table with all rows (long cells wrap in place).
 * Only split into multiple tables when the fenced body exceeds messageLimit;
 * never split merely because cells are long.
 * A single row that still cannot fit becomes a .txt attachment body.
 */
export function splitTableIntoDiscordBodies(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  options?: {
    readonly style?: AsciiTableStyle;
    readonly maxColWidth?: number;
    readonly maxTableWidth?: number;
    readonly messageLimit?: number;
  },
): {
  readonly fencedChunks: ReadonlyArray<string>;
  /** Unfenced bodies that could not fit even as a single-row table. */
  readonly oversizedBodies: ReadonlyArray<string>;
} {
  const style = options?.style ?? "rounded";
  const maxColWidth = options?.maxColWidth ?? DEFAULT_MAX_COL_WIDTH;
  const maxTableWidth = options?.maxTableWidth ?? DEFAULT_MAX_TABLE_WIDTH;
  const messageLimit = options?.messageLimit ?? DEFAULT_MESSAGE_LIMIT;

  if (headers.length === 0 || rows.length === 0) {
    return { fencedChunks: [], oversizedBodies: [] };
  }

  // Keep all rows in one table when possible; packRowsIntoGroups only splits
  // if the full fenced table exceeds messageLimit.
  const groups = packRowsIntoGroups(headers, rows, style, maxColWidth, maxTableWidth, messageLimit);

  const tableBodies: string[] = [];
  const oversizedBodies: string[] = [];

  for (const group of groups) {
    const body = renderTableBody(style, headers, group, maxColWidth, maxTableWidth);
    if (fenceTable(body).length <= messageLimit) {
      tableBodies.push(body);
      continue;
    }
    // Group still too big (usually a single huge row). Attach unfenced body.
    if (group.length === 1) {
      oversizedBodies.push(body);
      continue;
    }
    // Fall back to per-row only when a multi-row pack still overflows (edge case).
    for (const row of group) {
      const rowBody = renderTableBody(style, headers, [row], maxColWidth, maxTableWidth);
      if (fenceTable(rowBody).length <= messageLimit) {
        tableBodies.push(rowBody);
      } else {
        oversizedBodies.push(rowBody);
      }
    }
  }

  // Pack any size-split tables into as few fences as possible.
  const fencedChunks = packTableBodiesIntoFences(tableBodies, messageLimit);
  return { fencedChunks, oversizedBodies };
}

/**
 * Join unfenced ASCII tables into fenced code blocks under messageLimit.
 * Prefer one fence containing several tables over adjacent fences.
 */
export function packTableBodiesIntoFences(
  bodies: ReadonlyArray<string>,
  messageLimit: number,
): string[] {
  const fencedChunks: string[] = [];
  let pack: string[] = [];

  const flush = () => {
    if (pack.length === 0) return;
    fencedChunks.push(fenceTable(pack.join("\n\n")));
    pack = [];
  };

  for (const body of bodies) {
    const solo = fenceTable(body);
    if (solo.length > messageLimit) {
      // Caller should have filtered these; skip rather than emit an oversize fence.
      flush();
      continue;
    }
    if (pack.length === 0) {
      pack = [body];
      continue;
    }
    const combined = fenceTable([...pack, body].join("\n\n"));
    if (combined.length > messageLimit) {
      flush();
      pack = [body];
      continue;
    }
    pack.push(body);
  }
  flush();
  return fencedChunks;
}

/**
 * Join multiple fenced chunks for Discord without adjacent-fence glitches.
 * A zero-width space on its own line forces Discord to close/reopen snippets cleanly.
 */
export function joinFencedTableChunks(chunks: ReadonlyArray<string>): string {
  if (chunks.length === 0) return "";
  if (chunks.length === 1) return chunks[0] ?? "";
  // ZWSP between fences: Discord often drops subsequent code blocks when they
  // sit back-to-back with only blank lines between them.
  return chunks.join("\n\n\u200B\n\n");
}

function packRowsIntoGroups(
  headers: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
  style: AsciiTableStyle,
  maxColWidth: number,
  maxTableWidth: number,
  messageLimit: number,
): Array<ReadonlyArray<ReadonlyArray<string>>> {
  const groups: Array<ReadonlyArray<ReadonlyArray<string>>> = [];
  let current: Array<ReadonlyArray<string>> = [];

  for (const row of rows) {
    const candidate = [...current, row];
    const fenced = fenceTable(
      renderTableBody(style, headers, candidate, maxColWidth, maxTableWidth),
    );
    if (current.length > 0 && fenced.length > messageLimit) {
      groups.push(current);
      current = [row];
      continue;
    }
    current = candidate;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

/**
 * Replace markdown pipe tables with fenced ASCII tables.
 * Prefer one table; only rows/tables that still exceed the Discord limit become
 * .txt attachments. Attachment names follow document reading order.
 */
export function rewriteMarkdownTablesForDiscord(
  text: string,
  options?: {
    readonly style?: AsciiTableStyle;
    readonly maxColWidth?: number;
    readonly maxTableWidth?: number;
    /** Soft limit for a single fenced table; over this attaches as .txt. */
    readonly messageLimit?: number;
  },
): RewriteMarkdownTablesResult {
  const style = options?.style ?? "rounded";
  const maxColWidth = options?.maxColWidth ?? DEFAULT_MAX_COL_WIDTH;
  const maxTableWidth = options?.maxTableWidth ?? DEFAULT_MAX_TABLE_WIDTH;
  const messageLimit = options?.messageLimit ?? DEFAULT_MESSAGE_LIMIT;
  const matches = extractMarkdownTables(text);
  if (matches.length === 0) {
    return { text, attachments: [] };
  }

  // Collect attachments in document order; name by reading order (not reverse-replace order).
  const attachmentsByKey = new Map<string, DiscordTableAttachment>();
  let out = text;
  // Replace from the end so earlier offsets stay valid.
  for (let index = matches.length - 1; index >= 0; index -= 1) {
    const match = matches[index]!;
    const { fencedChunks, oversizedBodies } = splitTableIntoDiscordBodies(
      match.headers,
      match.rows,
      { style, maxColWidth, maxTableWidth, messageLimit },
    );

    const parts: string[] = [];
    if (fencedChunks.length > 0) {
      parts.push(joinFencedTableChunks(fencedChunks));
    }
    for (let bodyIndex = 0; bodyIndex < oversizedBodies.length; bodyIndex += 1) {
      const body = oversizedBodies[bodyIndex]!;
      const name = oversizedTableAttachmentName({
        matchIndex: index,
        bodyIndex,
        matchCount: matches.length,
        oversizedBodyCount: oversizedBodies.length,
        hasFencedChunks: fencedChunks.length > 0,
      });
      // Last write wins only if duplicate names; keys are unique per match/body.
      attachmentsByKey.set(`${index}:${bodyIndex}:${name}`, { name, body });
      parts.push(`_(Table attached as \`${name}\`)_`);
    }

    const replacement = parts.join("\n\n");
    out = `${out.slice(0, match.start)}${replacement}${out.slice(match.end)}`;
  }

  // Reading order: earlier match index first, then body index within the match.
  const attachments = [...attachmentsByKey.entries()]
    .toSorted(([left], [right]) => left.localeCompare(right, undefined, { numeric: true }))
    .map(([, attachment]) => attachment);

  return { text: out, attachments };
}

/** Stable attachment names in document reading order (table-1 = first table in message). */
export function oversizedTableAttachmentName(input: {
  readonly matchIndex: number;
  readonly bodyIndex: number;
  readonly matchCount: number;
  readonly oversizedBodyCount: number;
  readonly hasFencedChunks: boolean;
}): string {
  const { matchIndex, bodyIndex, matchCount, oversizedBodyCount, hasFencedChunks } = input;
  if (matchCount === 1 && oversizedBodyCount === 1 && !hasFencedChunks) {
    return "table.txt";
  }
  if (matchCount === 1) {
    return `table-${bodyIndex + 1}.txt`;
  }
  if (oversizedBodyCount === 1) {
    return `table-${matchIndex + 1}.txt`;
  }
  return `table-${matchIndex + 1}-${bodyIndex + 1}.txt`;
}

/**
 * Chunk Discord content without splitting inside fenced code blocks (including ASCII tables)
 * and without splitting mid-line of a table row when possible.
 */
export function chunkDiscordContentPreservingTables(
  content: string,
  limit = DEFAULT_MESSAGE_LIMIT,
): string[] {
  const trimmed = content.trimEnd();
  if (trimmed.length === 0) return [""];
  if (trimmed.length <= limit) return [trimmed];

  const segments = splitPreservingFences(trimmed);
  const chunks: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim().length > 0) {
      chunks.push(current.trimEnd());
    }
    current = "";
  };

  for (const segment of segments) {
    if (segment.length > limit) {
      // Oversized segment (should be rare after table attachment). Split on lines.
      flush();
      let remaining = segment;
      while (remaining.length > limit) {
        let splitAt = remaining.lastIndexOf("\n", limit);
        if (splitAt < Math.floor(limit * 0.5)) splitAt = limit;
        chunks.push(remaining.slice(0, splitAt).trimEnd());
        remaining = remaining.slice(splitAt).replace(/^\n/, "");
      }
      if (remaining.trim().length > 0) current = remaining;
      continue;
    }

    const separator = current.length > 0 ? "\n" : "";
    if (current.length + separator.length + segment.length <= limit) {
      current = current.length > 0 ? `${current}\n${segment}` : segment;
      continue;
    }
    flush();
    current = segment;
  }
  flush();
  return chunks.length > 0 ? chunks : [""];
}

/** Split text into fence blocks and non-fence blocks (each non-fence further by blank lines). */
function splitPreservingFences(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const segments: string[] = [];
  let buffer: string[] = [];
  let inFence = false;

  const flushBuffer = () => {
    if (buffer.length === 0) return;
    const block = buffer.join("\n");
    if (inFence) {
      segments.push(block);
    } else {
      // Split non-fence prose on blank lines for better chunk boundaries.
      const paragraphs = block.split(/\n{2,}/);
      for (const paragraph of paragraphs) {
        if (paragraph.length > 0) segments.push(paragraph);
      }
    }
    buffer = [];
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      if (!inFence) {
        flushBuffer();
        inFence = true;
        buffer.push(line);
      } else {
        buffer.push(line);
        flushBuffer();
        inFence = false;
      }
      continue;
    }
    buffer.push(line);
  }
  flushBuffer();
  return segments;
}
