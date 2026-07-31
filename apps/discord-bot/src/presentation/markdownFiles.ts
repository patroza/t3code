import {
  assertFilesystemPath,
  guessImageMimeType,
  normalizeLocalImagePath,
} from "./markdownImages.ts";

export interface MarkdownLocalFileRef {
  readonly label: string;
  /** Normalized filesystem path without any :line or :line:column suffix. */
  readonly src: string;
  /** Normalized link target including any :line or :line:column suffix. */
  readonly target: string;
  /** Original destination before normalization (for debugging). */
  readonly rawSrc: string;
  /** Full match including the markdown link syntax. */
  readonly match: string;
}

/** [label](url) / [label](<url>) */
const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\(\s*<?([^)\n>]+?)>?\s*\)/g;

function splitLocalFileTarget(value: string): {
  readonly path: string;
  readonly line?: string | undefined;
  readonly column?: string | undefined;
} {
  let path = value;
  let column: string | undefined;
  let line: string | undefined;

  const columnMatch = path.match(/:(\d+)$/u);
  if (!columnMatch?.[1]) {
    return { path };
  }

  column = columnMatch[1];
  path = path.slice(0, -columnMatch[0].length);

  const lineMatch = path.match(/:(\d+)$/u);
  if (lineMatch?.[1]) {
    line = lineMatch[1];
    path = path.slice(0, -lineMatch[0].length);
  } else {
    line = column;
    column = undefined;
  }

  return { path, line, column };
}

function hasFileLikeName(path: string): boolean {
  const base = path.split(/[/\\]/).at(-1) ?? "";
  return /\.[A-Za-z0-9_-]{1,16}$/u.test(base);
}

export function isLocalFileSrc(src: string): boolean {
  const raw = src.trim();
  if (raw === "") return false;
  if (/^https?:\/\//i.test(raw)) return false;
  if (/^data:/i.test(raw)) return false;

  const normalized = normalizeLocalImagePath(raw);
  if (normalized === "") return false;
  if (/^https?:\/\//i.test(normalized) || /^data:/i.test(normalized)) return false;
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(normalized)) return false;

  if (normalized.startsWith("/") || /^[A-Za-z]:[\\/]/.test(normalized)) return true;
  if (normalized.startsWith("./") || normalized.startsWith("../")) return true;
  return hasFileLikeName(normalized);
}

function looksLikeLocalFileTarget(rawSrc: string): boolean {
  if (!isLocalFileSrc(rawSrc)) return false;
  return hasFileLikeName(splitLocalFileTarget(normalizeLocalImagePath(rawSrc)).path);
}

export function extractMarkdownLocalFileLinks(text: string): ReadonlyArray<MarkdownLocalFileRef> {
  const results: MarkdownLocalFileRef[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const full = match[0];
    const label = (match[1] ?? "").trim();
    const rawSrc = (match[2] ?? "").trim();
    if (full === undefined || rawSrc === "") continue;
    if (!looksLikeLocalFileTarget(rawSrc)) continue;

    const target = normalizeLocalImagePath(rawSrc);
    const src = splitLocalFileTarget(target).path;
    const key = `${target}::${full}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      label,
      src,
      target,
      rawSrc,
      match: full,
    });
  }

  return results;
}

export function stripMarkdownLocalFileLinks(text: string): string {
  const refs = extractMarkdownLocalFileLinks(text);
  let out = text;
  const ordered = [...refs].sort((a, b) => b.match.length - a.match.length);
  for (const ref of ordered) {
    out = out.split(ref.match).join("");
  }
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function replaceMarkdownLocalFileLinks(
  text: string,
  replacer: (ref: MarkdownLocalFileRef) => string,
): string {
  const refs = extractMarkdownLocalFileLinks(text);
  let out = text;
  const ordered = [...refs].sort((a, b) => b.match.length - a.match.length);
  for (const ref of ordered) {
    out = out.split(ref.match).join(replacer(ref));
  }
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function fileNameForLocalFileRef(ref: MarkdownLocalFileRef): string {
  const path = assertFilesystemPath(ref.src);
  const base = path.split(/[/\\]/).at(-1) ?? "attachment.bin";
  const ext = /\.[A-Za-z0-9_-]{1,16}$/u.exec(base)?.[0] ?? "";

  const label = ref.label
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 128);
  if (label.length > 0) {
    if (ext !== "" && !label.toLowerCase().endsWith(ext.toLowerCase())) {
      return `${label}${ext}`;
    }
    return label;
  }
  return base;
}

export function guessFileMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(lower)) {
    return guessImageMimeType(lower);
  }
  if (lower.endsWith(".mp4")) return "video/mp4";
  if (lower.endsWith(".mov")) return "video/quicktime";
  if (lower.endsWith(".webm")) return "video/webm";
  if (lower.endsWith(".m4v")) return "video/x-m4v";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".m4a")) return "audio/mp4";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".flac")) return "audio/flac";
  // Discord documents preview support for plain text files rather than
  // structured formats like CSV/JSON specifically, so prefer text/plain for
  // text-ish artifacts to preserve the best chance of inline preview.
  if (
    lower.endsWith(".csv") ||
    lower.endsWith(".txt") ||
    lower.endsWith(".log") ||
    lower.endsWith(".md") ||
    lower.endsWith(".json") ||
    lower.endsWith(".yaml") ||
    lower.endsWith(".yml")
  ) {
    return "text/plain;charset=utf-8";
  }
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".zip")) return "application/zip";
  if (lower.endsWith(".gz")) return "application/gzip";
  return "application/octet-stream";
}

export { assertFilesystemPath };
