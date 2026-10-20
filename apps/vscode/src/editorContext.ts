export interface TextContext {
  readonly relativePath: string;
  readonly languageId: string;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly cursorColumn?: number;
  readonly kind: "selection" | "cursor-line" | "reference";
}

export interface ParsedEditorContext {
  readonly text: string;
  readonly references: ReadonlyArray<{ readonly path: string; readonly detail: string }>;
}

const MAX_CONTEXT_CHARS = 48_000;

function fenceFor(text: string): string {
  let fence = "```";
  while (text.includes(fence)) fence += "`";
  return fence;
}

export function renderTextContext(context: TextContext): string {
  const clipped =
    context.text.length > MAX_CONTEXT_CHARS
      ? `${context.text.slice(0, MAX_CONTEXT_CHARS)}\n… (context truncated)`
      : context.text;
  const range =
    context.startLine === context.endLine
      ? `line ${context.startLine}`
      : `lines ${context.startLine}-${context.endLine}`;
  const cursor = context.cursorColumn === undefined ? "" : `, column ${context.cursorColumn}`;
  const fence = fenceFor(clipped);
  return `### ${context.relativePath} (${range}${cursor})\n${fence}${context.languageId}\n${clipped}\n${fence}`;
}

export function composePrompt(prompt: string, contexts: ReadonlyArray<TextContext>): string {
  if (contexts.length === 0) return prompt;
  return `${prompt}\n\n<editor_context>\n${contexts.map(renderTextContext).join("\n\n")}\n</editor_context>`;
}

export function splitEditorContext(prompt: string): ParsedEditorContext {
  const references: Array<{ path: string; detail: string }> = [];
  const text = prompt.replace(
    /\n*<editor_context>\s*([\s\S]*?)\s*<\/editor_context>\s*/gu,
    (_match, body: string) => {
      for (const heading of body.matchAll(/^###\s+(.+?)\s+\(([^\n)]+)\)\s*$/gmu)) {
        references.push({ path: heading[1]!, detail: heading[2]! });
      }
      return "";
    },
  );
  return { text: text.trim(), references };
}
