import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/**
 * Stable React key for markdown tree siblings.
 *
 * Nitro/GFM table cells often share the same `beg`/`end` (commonly both `0`),
 * so keys of the form `type:beg:end` collide as `table_cell:0:0` and thrash
 * native text + LogBox. Sibling `index` is the only reliable discriminator.
 */
export function markdownNodeKey(node: MarkdownNode, index: number): string {
  // Prefix `i` / `b` / `e` so span values cannot collapse the key shape back to
  // the pre-fix `type:0:0` form when index is omitted by a bad caller.
  return `${node.type}:i${index}:b${node.beg ?? "na"}:e${node.end ?? "na"}`;
}

/** Grid-stable keys for markdown tables (row/col, independent of parser spans). */
export function markdownTableCellKey(rowIndex: number, cellIndex: number): string {
  return `table:r${rowIndex}:c${cellIndex}`;
}

export function markdownTableRowKey(rowIndex: number): string {
  return `table:r${rowIndex}`;
}
