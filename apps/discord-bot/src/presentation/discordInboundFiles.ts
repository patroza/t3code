// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { DiscordInboundAttachment } from "./discordInboundImages.ts";

const DISCORD_ATTACHMENT_STAGE_DIR = "t3-discord-attachments";
const MAX_DISCORD_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 120;

export interface SavedDiscordAttachment {
  readonly name: string;
  readonly absolutePath: string;
  readonly mimeType: string | null;
  readonly sizeBytes: number;
}

interface DiscordAttachmentSourceAttempt {
  readonly kind: "url" | "proxy_url";
  readonly url: string;
}

function sanitizePathSegment(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return fallback;
  const withoutControlChars = [...trimmed]
    .filter((char) => (char.codePointAt(0) ?? 0x20) >= 0x20)
    .join("");
  const sanitized = withoutControlChars
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[.\-\s]+/g, "")
    .trim();
  return sanitized.length > 0 ? sanitized : fallback;
}

function splitExtension(filename: string): { readonly stem: string; readonly extension: string } {
  const extension = NodePath.extname(filename);
  if (extension.length === 0) {
    return { stem: filename, extension: "" };
  }
  return { stem: filename.slice(0, -extension.length), extension };
}

function sanitizeAttachmentFilename(filename: string, index: number): string {
  const original = filename.trim() !== "" ? filename : `attachment-${index + 1}`;
  const { stem, extension } = splitExtension(original);
  const safeStem = sanitizePathSegment(stem, `attachment-${index + 1}`);
  const safeExtension = extension.replace(/[^a-z0-9.]+/gi, "").toLowerCase();
  const maxStemLength = Math.max(1, MAX_FILENAME_LENGTH - safeExtension.length);
  const trimmedStem = safeStem.slice(0, maxStemLength).trim() || `attachment-${index + 1}`;
  return `${trimmedStem}${safeExtension}`;
}

function ensureUniqueFilename(filename: string, seen: Set<string>, index: number): string {
  if (!seen.has(filename)) {
    seen.add(filename);
    return filename;
  }

  const { stem, extension } = splitExtension(filename);
  for (let attempt = 2; attempt < 10_000; attempt += 1) {
    const suffix = `-${attempt}`;
    const maxStemLength = Math.max(1, MAX_FILENAME_LENGTH - extension.length - suffix.length);
    const candidate =
      `${stem.slice(0, maxStemLength)}${suffix}${extension}` || `attachment-${index + 1}`;
    if (!seen.has(candidate)) {
      seen.add(candidate);
      return candidate;
    }
  }

  const fallback = `attachment-${index + 1}${extension}`;
  seen.add(fallback);
  return fallback;
}

export function formatDiscordAttachmentPromptBlock(
  attachments: ReadonlyArray<SavedDiscordAttachment>,
): string {
  if (attachments.length === 0) return "";
  const lines = [
    "## Discord attachments",
    "These files were attached to the Discord message that mentioned you. Open them from the local filesystem if needed.",
    ...attachments.map(
      (attachment) =>
        `- [${attachment.name}](${attachment.absolutePath})${
          attachment.mimeType
            ? ` (${attachment.mimeType}, ${attachment.sizeBytes} bytes)`
            : ` (${attachment.sizeBytes} bytes)`
        }`,
    ),
  ];
  return lines.join("\n");
}

export function appendDiscordAttachmentPromptBlock(input: {
  readonly prompt: string;
  readonly attachments: ReadonlyArray<SavedDiscordAttachment>;
}): string {
  const block = formatDiscordAttachmentPromptBlock(input.attachments);
  if (block.length === 0) return input.prompt;
  const prompt = input.prompt.trim();
  return prompt.length === 0 ? block : `${prompt}\n\n${block}`;
}

function getAttachmentSourceAttempts(
  attachment: DiscordInboundAttachment,
): ReadonlyArray<DiscordAttachmentSourceAttempt> {
  const attempts: DiscordAttachmentSourceAttempt[] = [];
  for (const candidate of [
    { kind: "url" as const, url: attachment.url },
    { kind: "proxy_url" as const, url: attachment.proxy_url },
  ]) {
    const sourceUrl = candidate.url;
    if (!sourceUrl) continue;
    if (attempts.some((attempt) => attempt.url === sourceUrl)) continue;
    attempts.push({ kind: candidate.kind, url: sourceUrl });
  }
  return attempts;
}

export async function downloadDiscordAttachmentsToWorkspace(input: {
  readonly attachments: ReadonlyArray<DiscordInboundAttachment>;
  readonly discordThreadId: string;
  readonly messageId: string;
}): Promise<{
  readonly saved: ReadonlyArray<SavedDiscordAttachment>;
  readonly skipped: ReadonlyArray<{ readonly filename: string; readonly reason: string }>;
}> {
  if (input.attachments.length === 0) {
    return { saved: [], skipped: [] };
  }

  const baseDir = NodePath.join(
    NodeOS.tmpdir(),
    DISCORD_ATTACHMENT_STAGE_DIR,
    sanitizePathSegment(input.discordThreadId, "thread"),
    sanitizePathSegment(input.messageId, "message"),
  );
  await NodeFSP.mkdir(baseDir, { recursive: true });

  const seenNames = new Set<string>();
  const saved: SavedDiscordAttachment[] = [];
  const skipped: Array<{ filename: string; reason: string }> = [];

  for (const [index, attachment] of input.attachments.entries()) {
    const filename = sanitizeAttachmentFilename(attachment.filename ?? "", index);
    const uniqueFilename = ensureUniqueFilename(filename, seenNames, index);
    const sourceAttempts = getAttachmentSourceAttempts(attachment);
    if (sourceAttempts.length === 0) {
      skipped.push({ filename: uniqueFilename, reason: "missing url" });
      continue;
    }
    if (typeof attachment.size === "number" && attachment.size > MAX_DISCORD_ATTACHMENT_BYTES) {
      skipped.push({
        filename: uniqueFilename,
        reason: `too large (${attachment.size} > ${MAX_DISCORD_ATTACHMENT_BYTES})`,
      });
      continue;
    }

    try {
      const failures: string[] = [];
      let savedAttachment: SavedDiscordAttachment | null = null;

      for (const source of sourceAttempts) {
        const response = await fetch(source.url);
        if (!response.ok) {
          failures.push(`${source.kind}:http ${response.status}`);
          continue;
        }

        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength === 0) {
          failures.push(`${source.kind}:empty body`);
          continue;
        }
        if (buffer.byteLength > MAX_DISCORD_ATTACHMENT_BYTES) {
          failures.push(
            `${source.kind}:too large (${buffer.byteLength} > ${MAX_DISCORD_ATTACHMENT_BYTES})`,
          );
          continue;
        }

        const absolutePath = NodePath.join(baseDir, uniqueFilename);
        await NodeFSP.writeFile(absolutePath, buffer);
        savedAttachment = {
          name: uniqueFilename,
          absolutePath,
          mimeType: attachment.content_type?.split(";")[0]?.trim() ?? null,
          sizeBytes: buffer.byteLength,
        };
        break;
      }

      if (savedAttachment) {
        saved.push(savedAttachment);
        continue;
      }

      skipped.push({
        filename: uniqueFilename,
        reason: failures.join("; ") || "download failed",
      });
    } catch (cause) {
      skipped.push({
        filename: uniqueFilename,
        reason: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { saved, skipped };
}

export const ATTACHMENT_ONLY_PROMPT =
  "[User attached one or more files without additional text. Inspect the linked file(s) and respond using the conversation context.]";
