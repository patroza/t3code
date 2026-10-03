// @effect-diagnostics nodeBuiltinImport:off
/**
 * Agents embed local filesystem images in several wire formats:
 *   ![alt](/var/lib/t3/.codex/generated_images/.../file.png)
 *   ![alt](attachment:/var/lib/...)
 *   <img src="/var/lib/t3/.codex/generated_images/..." alt="..." />
 *   [file.png](</var/lib/t3/.codex/generated_images/.../file.png>)
 *   ![alt](images/1.jpg)  — Grok ImageGen session-relative path
 *
 * Discord cannot render host paths — they must become real multipart file attachments.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface MarkdownImageRef {
  readonly alt: string;
  /** Normalized filesystem path (never has attachment: / file:// prefixes). */
  readonly src: string;
  /** Original destination before normalization (for debugging). */
  readonly rawSrc: string;
  /** Full match including the embed syntax */
  readonly match: string;
}

/** ![alt](url) and ![alt](<url>) */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\n>]+?)>?\s*\)/g;

/** [label](url) / [label](<url>) — only treated as images when the target looks local+image */
const MARKDOWN_LINK = /(?<!!)\[([^\]]*)\]\(\s*<?([^)\n>]+?)>?\s*\)/g;

/** HTML <img src="..." alt="..."> (attribute order flexible enough for common agent output) */
const HTML_IMG =
  /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*\/?>|<img\b[^>]*\bsrc\s*=\s*([^\s>]+)[^>]*\/?>/gi;

/** ACP / Codex media scheme prefixes that are not real filesystem paths. */
const MEDIA_SCHEME_PREFIX = /^(?:attachment:\/?\/?|file:\/\/)/i;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/**
 * Normalize agent/Codex image targets to a bare filesystem path (or leave http(s)).
 * Always strips angle brackets and attachment:/file:// schemes — repeatedly if nested.
 */
export function normalizeLocalImagePath(src: string): string {
  let value = src.trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }

  // Strip media schemes until gone.
  // IMPORTANT: only strip the scheme token — keep the leading `/` of absolute paths.
  //   attachment:/var/lib/...  →  /var/lib/...
  for (let i = 0; i < 4; i += 1) {
    if (/^https?:\/\//i.test(value) || /^data:/i.test(value)) {
      return value;
    }
    if (/^attachment:/i.test(value)) {
      value = value.replace(/^attachment:/i, "").trim();
      if (value.startsWith("//")) {
        value = `/${value.replace(/^\/+/, "")}`;
      }
      continue;
    }
    if (/^file:/i.test(value)) {
      try {
        value = decodeURIComponent(new URL(value).pathname);
        if (/^\/[A-Za-z]:[\\/]/.test(value)) {
          value = value.slice(1);
        }
      } catch {
        value = value
          .replace(/^file:\/\//i, "")
          .replace(/^file:/i, "")
          .trim();
      }
      continue;
    }
    break;
  }

  return value;
}

/**
 * True when the image target is a local path rather than an http(s) URL.
 */
export function isLocalImageSrc(src: string): boolean {
  const raw = src.trim();
  if (raw === "") return false;
  if (/^https?:\/\//i.test(raw)) return false;
  if (/^data:/i.test(raw)) return false;
  if (MEDIA_SCHEME_PREFIX.test(raw) || /^attachment:/i.test(raw)) return true;
  if (/^file:/i.test(raw)) return true;
  const value = normalizeLocalImagePath(raw);
  if (value === "") return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (value.startsWith("./") || value.startsWith("../")) return true;
  if (IMAGE_EXT.test(value)) return true;
  if (value.includes("generated_images")) return true;
  return false;
}

function looksLikeLocalImageTarget(rawSrc: string): boolean {
  if (!isLocalImageSrc(rawSrc)) return false;
  const path = normalizeLocalImagePath(rawSrc);
  return IMAGE_EXT.test(path) || path.includes("generated_images");
}

function pushUnique(
  results: MarkdownImageRef[],
  seen: Set<string>,
  input: { alt: string; rawSrc: string; match: string },
): void {
  const rawSrc = input.rawSrc.trim();
  if (rawSrc === "") return;
  if (!looksLikeLocalImageTarget(rawSrc) && !isLocalImageSrc(rawSrc)) return;
  // Require image-like path for link/html to avoid stripping normal file links.
  if (!looksLikeLocalImageTarget(rawSrc)) return;

  const src = normalizeLocalImagePath(rawSrc);
  const key = `${src}::${input.match}`;
  if (seen.has(key)) return;
  seen.add(key);
  results.push({
    alt: input.alt,
    src,
    rawSrc,
    match: input.match,
  });
}

/**
 * Extract every local image embed the agent might have put in the message:
 * markdown images, HTML <img>, and markdown links to image files.
 */
export function extractMarkdownImages(text: string): ReadonlyArray<MarkdownImageRef> {
  const results: MarkdownImageRef[] = [];
  const seen = new Set<string>();

  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    const full = match[0];
    if (full === undefined) continue;
    pushUnique(results, seen, {
      alt: match[1] ?? "",
      rawSrc: (match[2] ?? "").trim(),
      match: full,
    });
  }

  for (const match of text.matchAll(HTML_IMG)) {
    const full = match[0];
    if (full === undefined) continue;
    const rawSrc = (match[1] ?? match[2] ?? "").trim();
    const altMatch = /\balt\s*=\s*["']([^"']*)["']/i.exec(full);
    pushUnique(results, seen, {
      alt: altMatch?.[1] ?? "",
      rawSrc,
      match: full,
    });
  }

  for (const match of text.matchAll(MARKDOWN_LINK)) {
    const full = match[0];
    if (full === undefined) continue;
    // Skip if already captured as markdown image (negative lookbehind is imperfect in JS).
    if (full.startsWith("![")) continue;
    pushUnique(results, seen, {
      alt: match[1] ?? "",
      rawSrc: (match[2] ?? "").trim(),
      match: full,
    });
  }

  return results;
}

/** Remove all recognized local image embeds (md image, html img, md link-to-image). */
export function stripMarkdownImages(
  text: string,
  predicate: (ref: MarkdownImageRef) => boolean = () => true,
): string {
  const refs = extractMarkdownImages(text).filter(predicate);
  let out = text;
  // Remove longest matches first so nested/overlapping cases stay stable.
  const ordered = [...refs].sort((a, b) => b.match.length - a.match.length);
  for (const ref of ordered) {
    out = out.split(ref.match).join("");
  }
  return out.replace(/\n{3,}/g, "\n\n").trimEnd();
}

export function guessImageMimeType(filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

/**
 * Discord attachment filename — extension drives image preview vs generic file chip.
 * Prefer a human alt when present; fall back to the path basename.
 */
export function fileNameForImageRef(ref: MarkdownImageRef): string {
  const path = normalizeLocalImagePath(ref.src);
  const base = path.split(/[/\\]/).at(-1) ?? "image.png";
  const extMatch = IMAGE_EXT.exec(base);
  const ext = extMatch?.[0]?.toLowerCase() ?? ".png";

  const alt = ref.alt
    .trim()
    .replace(/[^\w.-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 64);
  if (alt.length > 0 && !/^call_[A-Za-z0-9]+$/i.test(alt)) {
    return IMAGE_EXT.test(alt) ? alt : `${alt}${ext}`;
  }
  if (IMAGE_EXT.test(base)) return base;
  return `image${ext}`;
}

/** Guard: never return a path that still starts with a media scheme. */
export function assertFilesystemPath(path: string): string {
  const normalized = normalizeLocalImagePath(path);
  if (/^attachment:/i.test(normalized) || /^file:/i.test(normalized)) {
    throw new Error(`Refusing to open media-scheme path: ${JSON.stringify(path)}`);
  }
  return normalized;
}

function safeStatMtimeMs(path: string): number {
  try {
    return NodeFS.statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Bounded walk for files under `root` whose path ends with `relativeSuffix`
 * (e.g. `images/1.jpg`) or whose basename matches when under an `images/` dir.
 * Returns newest match first. Depth-capped so large trees stay cheap.
 */
function findRecentImageFiles(
  root: string,
  relativeSuffix: string,
  fileBase: string,
  maxDepth = 6,
  maxHits = 8,
): string[] {
  if (!NodeFS.existsSync(root)) return [];
  const suffix = relativeSuffix
    .replace(/^\.?\//, "")
    .split(/[/\\]/)
    .join(NodePath.sep);
  const hits: Array<{ path: string; mtime: number }> = [];

  const walk = (dir: string, depth: number) => {
    if (hits.length >= maxHits || depth > maxDepth) return;
    let entries: ReadonlyArray<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;
    try {
      entries = NodeFS.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (hits.length >= maxHits) return;
      const full = NodePath.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!IMAGE_EXT.test(ent.name)) continue;
      const relFromRoot = full.slice(root.length).replace(/^[/\\]/, "");
      const underImages = `${NodePath.sep}images${NodePath.sep}${fileBase}`;
      const match =
        relFromRoot === suffix ||
        relFromRoot.endsWith(`${NodePath.sep}${suffix}`) ||
        (fileBase !== "" && (relFromRoot.endsWith(underImages) || ent.name === fileBase));
      if (!match) continue;
      // Prefer Grok/Codex generated locations over random repo assets named 1.jpg.
      const preferred =
        relFromRoot.includes(`${NodePath.sep}images${NodePath.sep}`) ||
        full.includes(`${NodePath.sep}.grok${NodePath.sep}sessions${NodePath.sep}`) ||
        full.includes(`${NodePath.sep}.codex${NodePath.sep}generated_images${NodePath.sep}`);
      if (!preferred && !relFromRoot.endsWith(suffix) && relFromRoot !== suffix) continue;
      hits.push({ path: full, mtime: safeStatMtimeMs(full) });
    }
  };

  walk(root, 0);
  return hits.sort((a, b) => b.mtime - a.mtime).map((h) => h.path);
}

/**
 * Resolve a markdown image target to an on-disk absolute path.
 *
 * Grok ImageGen embeds session-relative paths like `images/1.jpg` while the real
 * file lives under `~/.grok/sessions/<encoded-cwd>/<sessionId>/images/1.jpg`.
 * Codex usually emits absolute paths under `~/.codex/generated_images/…`.
 */
export function resolveImagePathOnDisk(path: string): string | null {
  const normalized = assertFilesystemPath(path);
  if (normalized === "" || /^https?:\/\//i.test(normalized) || /^data:/i.test(normalized)) {
    return null;
  }

  if (NodePath.isAbsolute(normalized)) {
    return NodeFS.existsSync(normalized) ? NodePath.normalize(normalized) : null;
  }

  const rel = normalized.replace(/^\.\//, "");
  const fromCwd = NodePath.join(process.cwd(), rel);
  if (NodeFS.existsSync(fromCwd)) return NodePath.normalize(fromCwd);

  const home = NodeOS.homedir();
  const fileBase = NodePath.basename(rel);
  const searchRoots = [
    NodePath.join(home, ".grok", "sessions"),
    NodePath.join(home, ".codex", "generated_images"),
    // Guest data layout (bot runs as t3; HOME may already be /var/lib/t3).
    "/var/lib/t3/.grok/sessions",
    "/var/lib/t3/.codex/generated_images",
  ];

  for (const root of searchRoots) {
    const hits = findRecentImageFiles(root, rel, fileBase);
    if (hits[0] !== undefined) return hits[0];
  }

  return null;
}
