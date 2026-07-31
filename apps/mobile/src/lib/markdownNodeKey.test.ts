import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import { markdownNodeKey } from "../../modules/t3-markdown-text/src/markdownNodeKey";

describe("markdownNodeKey", () => {
  it("keeps sibling keys unique when beg/end spans collide", () => {
    const cell = (index: number): MarkdownNode =>
      ({
        type: "table_cell",
        beg: 0,
        end: 0,
        children: [{ type: "text", content: `c${index}` }],
      }) as MarkdownNode;

    const keys = [0, 1, 2].map((index) => markdownNodeKey(cell(index), index));
    expect(keys).toEqual(["table_cell:0:0:0", "table_cell:1:0:0", "table_cell:2:0:0"]);
    expect(new Set(keys).size).toBe(3);
  });

  it("still differs by type and index when spans are missing", () => {
    expect(markdownNodeKey({ type: "paragraph" }, 0)).toBe("paragraph:0::");
    expect(markdownNodeKey({ type: "paragraph" }, 1)).toBe("paragraph:1::");
  });
});
