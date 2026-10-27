// @effect-diagnostics globalFetch:off
/**
 * Convert Discord message attachments into T3 UploadChatAttachment images
 * (data URLs) so providers receive the same shape as the web composer.
 */
import type { UploadChatAttachment } from "@t3tools/contracts";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

/** Minimal Discord attachment shape (gateway or REST). */
export interface DiscordInboundAttachment {
  readonly id?: string;
  readonly filename?: string;
  readonly url?: string;
  readonly proxy_url?: string;
  readonly size?: number;
  readonly content_type?: string | null;
  readonly width?: number;
  readonly height?: number;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

export function guessMimeFromFilename(filename: string): string | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".bmp")) return "image/bmp";
  return null;
}

export function isDiscordImageAttachment(att: DiscordInboundAttachment): boolean {
  const ct = att.content_type?.toLowerCase() ?? "";
  if (ct.startsWith("image/") && !ct.includes("svg")) return true;
  const name = att.filename ?? "";
  if (IMAGE_EXT.test(name)) return true;
  // Discord sometimes omits content_type but sets dimensions for images.
  if (
    typeof att.width === "number" &&
    att.width > 0 &&
    typeof att.height === "number" &&
    att.height > 0 &&
    name !== ""
  ) {
    return true;
  }
  return false;
}

export function filterDiscordImageAttachments(
  attachments: ReadonlyArray<DiscordInboundAttachment> | null | undefined,
): ReadonlyArray<DiscordInboundAttachment> {
  if (attachments === undefined || attachments === null) return [];
  return attachments.filter(isDiscordImageAttachment).slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
}

function uint8ToBase64(bytes: Uint8Array): string {
  // Chunk to avoid call-stack / argument limits on large images.
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Download Discord CDN images and build T3 upload attachments.
 * Skips oversize / failed downloads (logged by caller via returned skipped list).
 */
export async function downloadDiscordImagesAsUploadAttachments(
  attachments: ReadonlyArray<DiscordInboundAttachment>,
): Promise<{
  readonly uploads: ReadonlyArray<UploadChatAttachment>;
  readonly skipped: ReadonlyArray<{ readonly filename: string; readonly reason: string }>;
}> {
  const images = filterDiscordImageAttachments(attachments);
  const uploads: UploadChatAttachment[] = [];
  const skipped: Array<{ filename: string; reason: string }> = [];

  for (const att of images) {
    const filename = (att.filename ?? "image.png").slice(0, 255) || "image.png";
    const sourceUrl = att.proxy_url || att.url;
    if (sourceUrl === undefined || sourceUrl === "") {
      skipped.push({ filename, reason: "missing url" });
      continue;
    }
    if (typeof att.size === "number" && att.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      skipped.push({
        filename,
        reason: `too large (${att.size} > ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES})`,
      });
      continue;
    }

    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) {
        skipped.push({ filename, reason: `http ${response.status}` });
        continue;
      }
      const buffer = new Uint8Array(await response.arrayBuffer());
      if (buffer.byteLength === 0) {
        skipped.push({ filename, reason: "empty body" });
        continue;
      }
      if (buffer.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        skipped.push({
          filename,
          reason: `too large (${buffer.byteLength} > ${PROVIDER_SEND_TURN_MAX_IMAGE_BYTES})`,
        });
        continue;
      }

      const headerType = response.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      const mimeType =
        (att.content_type && att.content_type.startsWith("image/")
          ? att.content_type.split(";")[0]!.trim()
          : null) ??
        (headerType.startsWith("image/") ? headerType : null) ??
        guessMimeFromFilename(filename) ??
        "image/png";

      const dataUrl = `data:${mimeType};base64,${uint8ToBase64(buffer)}`;
      uploads.push({
        type: "image",
        name: filename,
        mimeType,
        sizeBytes: buffer.byteLength,
        dataUrl,
      });
    } catch (cause) {
      skipped.push({
        filename,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { uploads, skipped };
}

/** Prompt when the user only attached images (mirrors web empty-text image turns). */
export const IMAGE_ONLY_PROMPT =
  "[User attached one or more images without additional text. Respond using the conversation context and the attached image(s).]";
