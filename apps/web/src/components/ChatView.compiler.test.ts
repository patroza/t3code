// @effect-diagnostics nodeBuiltinImport:off - verifies the component's actual compiler output.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { transform } from "oxc-transform-react";
import { expect, it } from "vite-plus/test";

it("memoizes the ChatView component body", async () => {
  const sourceUrl = new URL("./ChatView.tsx", import.meta.url);
  const result = await transform(
    NodeURL.fileURLToPath(sourceUrl),
    NodeFS.readFileSync(sourceUrl, "utf8"),
    {
      jsx: { runtime: "automatic", development: false, refresh: false },
      reactCompiler: { reportDiagnostics: true },
    },
  );
  expect(result.errors.map((error) => error.codeframe ?? error.message)).toEqual([]);
  // Compiled helpers alone do not protect ChatView's render-state hooks from
  // freshly allocated inputs when the component itself silently bails out.
  expect(result.code).toMatch(/export default function ChatView\(props\) \{\s*const \$ = _c\(/);
});
