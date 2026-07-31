/**
 * Agents (especially Codex) often embed host filesystem images as markdown:
 *   ![alt](/var/lib/t3/.codex/generated_images/.../file.png)
 *   ![alt](</absolute/path.png>)
 * Browsers cannot load those paths; they must be resolved through the assets API.
 */

export function normalizeLocalMarkdownImageSrc(src: string): string {
  let value = src.trim();
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }
  // ACP / Codex tool media: attachment:/abs/path.png
  if (/^attachment:/i.test(value)) {
    value = value.replace(/^attachment:/i, "").trim();
  }
  if (value.startsWith("file://")) {
    try {
      value = decodeURIComponent(new URL(value).pathname);
      // Browser URL parser may keep a leading slash on Windows drive paths.
      if (/^\/[A-Za-z]:[\\/]/.test(value)) {
        value = value.slice(1);
      }
    } catch {
      value = value.replace(/^file:\/\//, "");
    }
  }
  return value;
}

/**
 * True when the image target is a local path rather than an http(s) URL the
 * browser can load directly.
 */
export function isLocalMarkdownImageSrc(src: string | undefined | null): boolean {
  if (src === undefined || src === null) return false;
  const raw = src.trim();
  if (raw === "") return false;
  if (/^https?:\/\//i.test(raw)) return false;
  if (/^data:/i.test(raw)) return false;
  if (/^blob:/i.test(raw)) return false;
  if (/^attachment:/i.test(raw)) return true;
  const value = normalizeLocalMarkdownImageSrc(src);
  if (value === "") return false;
  if (/^https?:\/\//i.test(value)) return false;
  if (value.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(value)) return true;
  if (value.startsWith("./") || value.startsWith("../")) return true;
  if (value.includes("generated_images")) return true;
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(value)) {
    // Relative image-looking path (no scheme).
    return !value.includes("://");
  }
  return false;
}
