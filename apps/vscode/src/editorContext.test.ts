import { describe, expect, it } from "vite-plus/test";

import { composePrompt, renderTextContext, splitEditorContext } from "./editorContext.ts";

describe("editor context", () => {
  it("describes precise selections", () => {
    expect(
      renderTextContext({
        relativePath: "src/main.ts",
        languageId: "typescript",
        text: "const answer = 42;",
        startLine: 8,
        endLine: 8,
        kind: "selection",
      }),
    ).toContain("src/main.ts (line 8)\n```typescript\nconst answer = 42;\n```");
  });

  it("keeps context separate from the authored prompt", () => {
    const rendered = composePrompt("Explain this", [
      {
        relativePath: "readme.md",
        languageId: "markdown",
        text: "hello",
        startLine: 1,
        endLine: 1,
        cursorColumn: 3,
        kind: "cursor-line",
      },
    ]);
    expect(rendered).toMatch(/^Explain this\n\n<editor_context>/);
    expect(rendered).toContain("line 1, column 3");
    expect(splitEditorContext(rendered)).toEqual({
      text: "Explain this",
      references: [{ path: "readme.md", detail: "line 1, column 3" }],
    });
  });
});
