/**
 * Markdown → Atlassian Document Format for Jira Cloud comments.
 *
 * The bridge used to drop the reply in as paragraph text, so `[label](url)` and
 * ``` fences showed up as source. This covers the Markdown agents actually write:
 * headings, emphasis, links, lists, tables, quotes, and fenced code.
 *
 * A comment that will not fit in Jira's body limit is split on a block boundary.
 * The caller stores the overflow (Confluence section or issue attachment) and
 * leaves a link in the comment.
 */
import { jiraMentionAccountId, type JiraAdfMention } from "./JiraWebhookPayload.ts";

/** Serialized ADF budget. Jira rejects comment bodies past 32,767 characters. */
export const JIRA_COMMENT_ADF_BUDGET = 24_000;

export type JiraStoredOverflow = {
  readonly kind: "confluence" | "attachment";
  readonly label: string;
  readonly url: string;
};

export type JiraMarkdownPlatform = "jira" | "confluence";

export type JiraAdfMark = {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, string>>;
};

export type JiraAdfNode = {
  readonly type: string;
  readonly text?: string;
  readonly attrs?: Readonly<Record<string, unknown>>;
  readonly marks?: ReadonlyArray<JiraAdfMark>;
  readonly content?: ReadonlyArray<JiraAdfNode>;
};

export type JiraAdfDoc = {
  readonly type: "doc";
  readonly version: 1;
  readonly content: ReadonlyArray<JiraAdfNode>;
};

type ParagraphLine = {
  readonly text: string;
  readonly hardBreak: boolean;
};

type Block =
  | { readonly type: "paragraph"; readonly lines: ReadonlyArray<ParagraphLine> }
  | { readonly type: "heading"; readonly level: number; readonly text: string }
  | { readonly type: "code"; readonly language: string | undefined; readonly text: string }
  | { readonly type: "bullet"; readonly items: ReadonlyArray<ReadonlyArray<Block>> }
  | {
      readonly type: "ordered";
      readonly order: number;
      readonly items: ReadonlyArray<ReadonlyArray<Block>>;
    }
  | { readonly type: "quote"; readonly blocks: ReadonlyArray<Block> }
  | { readonly type: "rule" }
  | {
      readonly type: "table";
      readonly header: ReadonlyArray<string>;
      readonly rows: ReadonlyArray<ReadonlyArray<string>>;
    };

type SourcedBlock = {
  readonly block: Block;
  readonly end: number;
};

type Line = {
  readonly text: string;
  readonly end: number;
};

export function markdownToAdf(
  markdown: string,
  options?: {
    readonly mention?: JiraAdfMention | null | undefined;
    /**
     * Jira comments set `codeBlock.attrs.wrap`. Confluence rejects that attribute,
     * so page sections omit it.
     */
    readonly platform?: JiraMarkdownPlatform | undefined;
  },
): JiraAdfDoc {
  const platform = options?.platform ?? "jira";
  const content = renderBlocks(parseBlocks(markdown), platform);
  return { type: "doc", version: 1, content: withMention(content, options?.mention) };
}

/**
 * Keep a leading slice whose ADF fits in a comment. `overflow` is the remainder
 * on a block boundary, or null when the whole reply fits.
 */
export function partitionJiraComment(markdown: string): {
  readonly inline: string;
  readonly overflow: string | null;
} {
  const source = markdown.trim();
  if (source.length === 0) return { inline: "", overflow: null };
  if (JSON.stringify(markdownToAdf(source)).length <= JIRA_COMMENT_ADF_BUDGET) {
    return { inline: source, overflow: null };
  }
  const parts = parseSourced(source);
  let kept = 0;
  let keptEnd = 0;
  for (const part of parts) {
    const size = JSON.stringify(
      blocksToDoc(parts.slice(0, kept + 1).map((item) => item.block)),
    ).length;
    if (size > JIRA_COMMENT_ADF_BUDGET) break;
    kept += 1;
    keptEnd = part.end;
  }
  if (kept === 0) return { inline: "", overflow: source };
  const inline = source.slice(0, keptEnd).trim();
  const overflow = source.slice(keptEnd).trim();
  if (overflow.length === 0) return { inline: source, overflow: null };
  return { inline, overflow };
}

export function jiraOverflowNotice(stored: JiraStoredOverflow | null): string {
  if (stored === null) {
    return "The rest of this answer did not fit in the comment, and storing it failed.";
  }
  if (stored.kind === "confluence") {
    return `The rest of this answer is on [${stored.label}](${stored.url}).`;
  }
  return `The rest of this answer is attached: [${stored.label}](${stored.url}).`;
}

function blocksToDoc(blocks: ReadonlyArray<Block>): JiraAdfDoc {
  return { type: "doc", version: 1, content: renderBlocks(blocks, "jira") };
}

function renderBlocks(blocks: ReadonlyArray<Block>, platform: JiraMarkdownPlatform): JiraAdfNode[] {
  return blocks.flatMap((block) => renderBlock(block, platform));
}

function renderBlock(block: Block, platform: JiraMarkdownPlatform): JiraAdfNode[] {
  switch (block.type) {
    case "paragraph": {
      const content = renderParagraph(block.lines);
      return content.length > 0 ? [{ type: "paragraph", content }] : [];
    }
    case "heading": {
      const content = parseInline(block.text);
      if (content.length === 0) return [];
      return [{ type: "heading", attrs: { level: block.level }, content }];
    }
    case "code": {
      if (block.text.length === 0) return [];
      const attrs: Record<string, unknown> = {};
      if (platform === "jira") attrs.wrap = true;
      if (block.language !== undefined) attrs.language = block.language;
      return [
        {
          type: "codeBlock",
          ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
          content: [{ type: "text", text: block.text }],
        },
      ];
    }
    case "bullet":
    case "ordered": {
      const items = block.items.flatMap((item) => {
        const content = renderBlocks(item, platform);
        return content.length > 0 ? [{ type: "listItem" as const, content }] : [];
      });
      if (items.length === 0) return [];
      if (block.type === "ordered") {
        return [{ type: "orderedList", attrs: { order: block.order }, content: items }];
      }
      return [{ type: "bulletList", content: items }];
    }
    case "quote": {
      const content = renderBlocks(block.blocks, platform);
      return content.length > 0 ? [{ type: "blockquote", content }] : [];
    }
    case "rule":
      return [{ type: "rule" }];
    case "table":
      return [renderTable(block.header, block.rows)];
  }
}

function renderParagraph(lines: ReadonlyArray<ParagraphLine>): JiraAdfNode[] {
  const nodes: JiraAdfNode[] = [];
  lines.forEach((line, index) => {
    if (index > 0) {
      const previous = lines[index - 1];
      nodes.push(previous?.hardBreak ? { type: "hardBreak" } : { type: "text", text: " " });
    }
    nodes.push(...parseInline(line.text));
  });
  return mergeText(nodes.filter((node) => node.type !== "text" || (node.text ?? "").length > 0));
}

function renderTable(
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): JiraAdfNode {
  const toCell = (kind: "tableHeader" | "tableCell", text: string): JiraAdfNode => ({
    type: kind,
    attrs: {},
    content: [{ type: "paragraph", content: parseInline(text) }],
  });
  const headerRow: JiraAdfNode = {
    type: "tableRow",
    content: header.map((cell) => toCell("tableHeader", cell)),
  };
  const body = rows.map((row): JiraAdfNode => ({
    type: "tableRow",
    content: header.map((_, index) => toCell("tableCell", row[index] ?? "")),
  }));
  return {
    type: "table",
    attrs: { isNumberColumnEnabled: false, layout: "default" },
    content: [headerRow, ...body],
  };
}

function withMention(
  content: ReadonlyArray<JiraAdfNode>,
  mention: JiraAdfMention | null | undefined,
): JiraAdfNode[] {
  const accountId = jiraMentionAccountId(mention?.accountId?.trim() ?? "");
  if (accountId.length === 0) return content.length > 0 ? [...content] : [emptyParagraph()];
  const display = mention?.displayName?.trim().replace(/^@/u, "") || accountId;
  const node: JiraAdfNode = {
    type: "mention",
    attrs: { id: accountId, text: `@${display}`, accessLevel: "" },
  };
  const first = content[0];
  if (first?.type === "paragraph") {
    return [
      { ...first, content: [node, { type: "text", text: " " }, ...(first.content ?? [])] },
      ...content.slice(1),
    ];
  }
  return [{ type: "paragraph", content: [node] }, ...content];
}

function emptyParagraph(): JiraAdfNode {
  return { type: "paragraph", content: [{ type: "text", text: " " }] };
}

function parseInline(input: string): JiraAdfNode[] {
  const nodes: JiraAdfNode[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer.length === 0) return;
    nodes.push({ type: "text", text: buffer });
    buffer = "";
  };
  let index = 0;
  while (index < input.length) {
    const rest = input.slice(index);
    if (rest.startsWith("`")) {
      const close = rest.indexOf("`", 1);
      if (close > 1) {
        flush();
        nodes.push({ type: "text", text: rest.slice(1, close), marks: [{ type: "code" }] });
        index += close + 1;
        continue;
      }
    }
    const link = matchLink(rest);
    if (link !== null) {
      flush();
      const href = safeHref(link.href);
      const inner = parseInline(link.label);
      nodes.push(...(href === null ? inner : withMark(inner, { type: "link", attrs: { href } })));
      index += link.length;
      continue;
    }
    const strong = matchDelimited(rest, "**") ?? matchDelimited(rest, "__");
    if (strong !== null) {
      flush();
      nodes.push(...withMark(parseInline(strong.inner), { type: "strong" }));
      index += strong.length;
      continue;
    }
    const strike = matchDelimited(rest, "~~");
    if (strike !== null) {
      flush();
      nodes.push(...withMark(parseInline(strike.inner), { type: "strike" }));
      index += strike.length;
      continue;
    }
    const marker = rest[0];
    if ((marker === "*" || marker === "_") && canOpenEmphasis(input, index, marker)) {
      const close = findEmphasisClose(input, index + 1, marker);
      if (close > index + 1) {
        flush();
        nodes.push(...withMark(parseInline(input.slice(index + 1, close)), { type: "em" }));
        index = close + 1;
        continue;
      }
    }
    const autolink = matchAutolink(rest);
    if (autolink !== null) {
      flush();
      nodes.push({
        type: "text",
        text: autolink.url,
        marks: [{ type: "link", attrs: { href: autolink.url } }],
      });
      index += autolink.length;
      continue;
    }
    buffer += input[index] ?? "";
    index += 1;
  }
  flush();
  return mergeText(nodes);
}

function withMark(nodes: ReadonlyArray<JiraAdfNode>, mark: JiraAdfMark): JiraAdfNode[] {
  return nodes.map((node) => {
    if (node.type !== "text") return node;
    if (node.marks?.some((item) => item.type === "code")) return node;
    return { ...node, marks: [...(node.marks ?? []), mark] };
  });
}

function mergeText(nodes: ReadonlyArray<JiraAdfNode>): JiraAdfNode[] {
  const merged: JiraAdfNode[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (
      node.type === "text" &&
      previous?.type === "text" &&
      JSON.stringify(previous.marks ?? []) === JSON.stringify(node.marks ?? [])
    ) {
      merged[merged.length - 1] = { ...previous, text: `${previous.text ?? ""}${node.text ?? ""}` };
      continue;
    }
    if (node.type === "text" && (node.text ?? "").length === 0) continue;
    merged.push(node);
  }
  return merged;
}

function matchDelimited(
  rest: string,
  delimiter: string,
): { readonly inner: string; readonly length: number } | null {
  if (!rest.startsWith(delimiter)) return null;
  const close = rest.indexOf(delimiter, delimiter.length);
  if (close <= delimiter.length) return null;
  return { inner: rest.slice(delimiter.length, close), length: close + delimiter.length };
}

function canOpenEmphasis(input: string, index: number, marker: "*" | "_"): boolean {
  const next = input[index + 1];
  if (next === undefined || /\s/u.test(next) || next === marker) return false;
  const previous = index === 0 ? "" : (input[index - 1] ?? "");
  if (marker === "_" && /[A-Za-z0-9]/u.test(previous)) return false;
  return true;
}

function findEmphasisClose(input: string, from: number, marker: "*" | "_"): number {
  for (let index = from; index < input.length; index += 1) {
    if (input[index] !== marker) continue;
    if (input[index + 1] === marker) continue;
    const previous = input[index - 1] ?? "";
    if (/\s/u.test(previous)) continue;
    const next = input[index + 1] ?? "";
    if (marker === "_" && /[A-Za-z0-9]/u.test(next)) continue;
    return index;
  }
  return -1;
}

function matchLink(
  rest: string,
): { readonly label: string; readonly href: string; readonly length: number } | null {
  if (!rest.startsWith("[")) return null;
  let depth = 1;
  let index = 1;
  while (index < rest.length && depth > 0) {
    const char = rest[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    if (depth === 0) break;
    index += 1;
  }
  if (depth !== 0 || rest[index] !== "]" || rest[index + 1] !== "(") return null;
  const hrefStart = index + 2;
  if (rest[hrefStart] === "<") {
    const end = rest.indexOf(">", hrefStart + 1);
    if (end < 0 || rest[end + 1] !== ")") return null;
    return { label: rest.slice(1, index), href: rest.slice(hrefStart + 1, end), length: end + 2 };
  }
  const close = rest.indexOf(")", hrefStart);
  if (close < 0) return null;
  const rawHref = rest.slice(hrefStart, close).trim();
  const href = rawHref.replace(/\s+["'].*$/u, "");
  return { label: rest.slice(1, index), href, length: close + 1 };
}

function safeHref(url: string): string | null {
  const href = url.trim();
  if (/^(https?:|mailto:)/iu.test(href)) return href;
  if (href.startsWith("/") || href.startsWith("#")) return href;
  return null;
}

function matchAutolink(rest: string): { readonly url: string; readonly length: number } | null {
  const match = /^https?:\/\/[^\s<>\]]+/iu.exec(rest);
  if (match === null) return null;
  let url = match[0] ?? "";
  while (/[.,;:!?)]$/u.test(url)) url = url.slice(0, -1);
  if (!/^https?:\/\/\S+$/iu.test(url)) return null;
  return { url, length: url.length };
}

function parseBlocks(markdown: string): Block[] {
  return parseSourced(markdown).map((part) => part.block);
}

function parseSourced(markdown: string): SourcedBlock[] {
  const lines = splitLines(markdown);
  return parseLineRange(lines, 0, lines.length).blocks;
}

function parseLineRange(
  lines: ReadonlyArray<Line>,
  start: number,
  end: number,
): { readonly blocks: SourcedBlock[]; readonly next: number } {
  const blocks: SourcedBlock[] = [];
  let index = start;
  while (index < end) {
    if ((lines[index]?.text ?? "").trim().length === 0) {
      index += 1;
      continue;
    }
    const parsed =
      parseFence(lines, index, end) ??
      parseHeading(lines, index) ??
      parseRule(lines, index) ??
      parseQuote(lines, index, end) ??
      parseList(lines, index, end) ??
      parseTable(lines, index, end) ??
      parseParagraph(lines, index, end);
    if (parsed === null || parsed.next <= index) {
      index += 1;
      continue;
    }
    blocks.push({ block: parsed.block, end: parsed.end });
    index = parsed.next;
  }
  return { blocks, next: index };
}

function parseFence(
  lines: ReadonlyArray<Line>,
  index: number,
  end: number,
): { readonly block: Block; readonly next: number; readonly end: number } | null {
  const open = matchFence(lines[index]?.text ?? "");
  if (open === null) return null;
  const body: string[] = [];
  let cursor = index + 1;
  while (cursor < end) {
    const text = lines[cursor]?.text ?? "";
    if (isClosingFence(text, open.char, open.length)) break;
    body.push(text);
    cursor += 1;
  }
  const closed = cursor < end;
  const last = lines[closed ? cursor : cursor - 1];
  return {
    block: { type: "code", language: codeLanguage(open.info), text: body.join("\n") },
    next: closed ? cursor + 1 : cursor,
    end: last?.end ?? lines[index]?.end ?? 0,
  };
}

function parseHeading(
  lines: ReadonlyArray<Line>,
  index: number,
): { readonly block: Block; readonly next: number; readonly end: number } | null {
  const match = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(lines[index]?.text ?? "");
  if (match === null) return null;
  return {
    block: { type: "heading", level: match[1]!.length, text: match[2]!.trim() },
    next: index + 1,
    end: lines[index]?.end ?? 0,
  };
}

function parseRule(
  lines: ReadonlyArray<Line>,
  index: number,
): { readonly block: Block; readonly next: number; readonly end: number } | null {
  if (!isRule(lines[index]?.text ?? "")) return null;
  return { block: { type: "rule" }, next: index + 1, end: lines[index]?.end ?? 0 };
}

function parseQuote(
  lines: ReadonlyArray<Line>,
  index: number,
  end: number,
): { readonly block: Block; readonly next: number; readonly end: number } | null {
  if (!isQuote(lines[index]?.text ?? "")) return null;
  const inner: string[] = [];
  let cursor = index;
  while (cursor < end && isQuote(lines[cursor]?.text ?? "")) {
    inner.push(quoteText(lines[cursor]?.text ?? ""));
    cursor += 1;
  }
  return {
    block: { type: "quote", blocks: parseBlocks(inner.join("\n")) },
    next: cursor,
    end: lines[cursor - 1]?.end ?? 0,
  };
}

function parseList(
  lines: ReadonlyArray<Line>,
  index: number,
  end: number,
  indent?: number,
): { readonly block: Block; readonly next: number; readonly end: number } | null {
  const first = matchList(lines[index]?.text ?? "");
  if (first === null) return null;
  if (indent !== undefined && first.indent !== indent) return null;
  const base = first.indent;
  const ordered = first.ordered;
  const order = first.order;
  const items: Block[][] = [];
  let cursor = index;
  let sourceEnd = lines[index]?.end ?? 0;
  while (cursor < end) {
    while (cursor < end && (lines[cursor]?.text ?? "").trim().length === 0) {
      const nextItem = nextNonBlank(lines, cursor + 1, end);
      if (nextItem === null) break;
      const peeked = matchList(lines[nextItem]?.text ?? "");
      if (peeked === null || peeked.indent < base || peeked.ordered !== ordered) break;
      cursor = nextItem;
    }
    const current = matchList(lines[cursor]?.text ?? "");
    if (current === null || current.indent < base || current.ordered !== ordered) break;
    if (current.indent > base) {
      if (items.length === 0) break;
      const nested = parseList(lines, cursor, end, current.indent);
      if (nested === null) break;
      items[items.length - 1] = [...(items[items.length - 1] ?? []), nested.block];
      cursor = nested.next;
      sourceEnd = nested.end;
      continue;
    }
    const content: ParagraphLine[] = [{ text: current.content, hardBreak: false }];
    cursor += 1;
    sourceEnd = lines[cursor - 1]?.end ?? sourceEnd;
    while (cursor < end) {
      const text = lines[cursor]?.text ?? "";
      if (text.trim().length === 0) break;
      const nested = matchList(text);
      if (nested !== null) break;
      if (matchFence(text) !== null || isHeading(text) || isRule(text) || isQuote(text)) break;
      const leading = text.match(/^ */u)?.[0].length ?? 0;
      if (leading <= base) break;
      content.push({ text: text.trim(), hardBreak: false });
      sourceEnd = lines[cursor]?.end ?? sourceEnd;
      cursor += 1;
    }
    const itemBlocks: Block[] = [{ type: "paragraph", lines: content }];
    if (cursor < end) {
      const nestedAt = matchList(lines[cursor]?.text ?? "");
      if (nestedAt !== null && nestedAt.indent > base) {
        const nested = parseList(lines, cursor, end, nestedAt.indent);
        if (nested !== null) {
          itemBlocks.push(nested.block);
          cursor = nested.next;
          sourceEnd = nested.end;
        }
      }
    }
    items.push(itemBlocks);
  }
  if (items.length === 0) return null;
  const block: Block = ordered ? { type: "ordered", order, items } : { type: "bullet", items };
  return { block, next: cursor, end: sourceEnd };
}

function parseTable(
  lines: ReadonlyArray<Line>,
  index: number,
  end: number,
): { readonly block: Block; readonly next: number; readonly end: number } | null {
  if (index + 1 >= end) return null;
  const headerLine = lines[index]?.text ?? "";
  const separator = lines[index + 1]?.text ?? "";
  if (!headerLine.includes("|") || matchList(headerLine) !== null || !isTableSeparator(separator))
    return null;
  const header = splitTableRow(headerLine);
  const rows: string[][] = [];
  let cursor = index + 2;
  while (cursor < end) {
    const text = lines[cursor]?.text ?? "";
    if (text.trim().length === 0 || !text.includes("|")) break;
    rows.push(splitTableRow(text));
    cursor += 1;
  }
  return {
    block: { type: "table", header, rows },
    next: cursor,
    end: lines[cursor - 1]?.end ?? 0,
  };
}

function parseParagraph(
  lines: ReadonlyArray<Line>,
  index: number,
  end: number,
): { readonly block: Block; readonly next: number; readonly end: number } | null {
  const content: ParagraphLine[] = [];
  let cursor = index;
  while (cursor < end) {
    const text = lines[cursor]?.text ?? "";
    if (text.trim().length === 0) break;
    if (cursor > index && interruptsParagraph(text)) break;
    const hardBreak = text.endsWith("\\") || /[ \t]{2,}$/u.test(text);
    const stripped = text.endsWith("\\") ? text.slice(0, -1) : text;
    content.push({ text: stripped.replace(/[ \t]{2,}$/u, ""), hardBreak });
    cursor += 1;
  }
  if (content.length === 0) return null;
  return {
    block: { type: "paragraph", lines: content },
    next: cursor,
    end: lines[cursor - 1]?.end ?? 0,
  };
}

function interruptsParagraph(text: string): boolean {
  return (
    matchFence(text) !== null ||
    isHeading(text) ||
    isRule(text) ||
    isQuote(text) ||
    matchList(text) !== null
  );
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== "\n") continue;
    lines.push({ text: source.slice(start, index), end: index + 1 });
    start = index + 1;
  }
  if (start < source.length) lines.push({ text: source.slice(start), end: source.length });
  return lines;
}

function nextNonBlank(lines: ReadonlyArray<Line>, index: number, end: number): number | null {
  for (let cursor = index; cursor < end; cursor += 1) {
    if ((lines[cursor]?.text ?? "").trim().length > 0) return cursor;
  }
  return null;
}

function matchFence(
  text: string,
): { readonly char: "`" | "~"; readonly length: number; readonly info: string } | null {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(text);
  if (match === null) return null;
  const fence = match[1] ?? "";
  const info = match[2] ?? "";
  if (fence.startsWith("`") && info.includes("`")) return null;
  return { char: fence.startsWith("`") ? "`" : "~", length: fence.length, info: info.trim() };
}

function isClosingFence(text: string, char: "`" | "~", length: number): boolean {
  const match = new RegExp(`^ {0,3}${char}{${length},}\\s*$`, "u").exec(text);
  return match !== null;
}

function codeLanguage(info: string): string | undefined {
  const token = info.trim().split(/\s+/u)[0]?.toLowerCase() ?? "";
  if (!/^[a-z0-9#+.-]{1,32}$/u.test(token)) return undefined;
  return token;
}

function isHeading(text: string): boolean {
  return /^#{1,6}[ \t]+\S/u.test(text);
}

function isRule(text: string): boolean {
  return /^ {0,3}((-\s*){3,}|(\*\s*){3,}|(_\s*){3,})$/u.test(text);
}

function isQuote(text: string): boolean {
  return /^ {0,3}>/u.test(text);
}

function quoteText(text: string): string {
  return text.replace(/^ {0,3}>\s?/u, "");
}

function matchList(text: string): {
  readonly indent: number;
  readonly ordered: boolean;
  readonly order: number;
  readonly content: string;
} | null {
  const match = /^( *)([-+*]|(\d{1,9})[.)])[ \t]+(.*)$/u.exec(text.replace(/\t/gu, "  "));
  if (match === null) return null;
  const marker = match[2] ?? "";
  const ordered = /\d/u.test(marker[0] ?? "");
  return {
    indent: (match[1] ?? "").length,
    ordered,
    order: ordered ? Number(match[3]) : 1,
    content: match[4] ?? "",
  };
}

function isTableSeparator(text: string): boolean {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(text);
}

function splitTableRow(text: string): string[] {
  let row = text.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}
