import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import {
  markdownNodeKey,
  markdownTableCellKey,
  markdownTableRowKey,
} from "../../modules/t3-markdown-text/src/markdownNodeKey";

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
    // Never the pre-fix shape `table_cell:0:0` (type:beg:end with shared spans).
    expect(keys).toEqual(["table_cell:i0:b0:e0", "table_cell:i1:b0:e0", "table_cell:i2:b0:e0"]);
    expect(new Set(keys).size).toBe(3);
    expect(keys.some((key) => key === "table_cell:0:0")).toBe(false);
  });

  it("still differs by type and index when spans are missing", () => {
    expect(markdownNodeKey({ type: "paragraph" }, 0)).toBe("paragraph:i0:bna:ena");
    expect(markdownNodeKey({ type: "paragraph" }, 1)).toBe("paragraph:i1:bna:ena");
  });
});

describe("markdownTableCellKey", () => {
  it("uses row/col coordinates so table grids never collide on parser spans", () => {
    expect(markdownTableRowKey(0)).toBe("table:r0");
    expect(markdownTableCellKey(0, 0)).toBe("table:r0:c0");
    expect(markdownTableCellKey(0, 1)).toBe("table:r0:c1");
    expect(markdownTableCellKey(1, 0)).toBe("table:r1:c0");
    expect(new Set([markdownTableCellKey(0, 0), markdownTableCellKey(0, 1)]).size).toBe(2);
  });
});
