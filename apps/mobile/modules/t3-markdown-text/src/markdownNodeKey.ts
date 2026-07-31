import type { MarkdownNode } from "react-native-nitro-markdown/headless";

/**
 * Stable React key for markdown tree siblings.
 *
 * Always includes `index`: nitro/GFM table cells (and some other nodes) often
 * share the same `beg`/`end` span (e.g. multiple `table_cell:0:0`), which
 * produced duplicate keys, thrashing native text views and spiking LogBox + RAM.
 */
export function markdownNodeKey(node: MarkdownNode, index: number): string {
  return `${node.type}:${index}:${node.beg ?? ""}:${node.end ?? ""}`;
}
