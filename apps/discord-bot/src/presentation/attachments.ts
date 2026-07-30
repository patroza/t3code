import type { ChatAttachment, ChatImageAttachment } from "@t3tools/contracts";

/** Discord allows up to 10 files per message. */
export const DISCORD_MAX_FILES_PER_MESSAGE = 10;

/**
 * Filename for the archived in-progress stream (hidden after finalize).
 * Short finals stay as normal Discord message content; long / table-heavy
 * finals use {@link FINAL_RESPONSE_MARKDOWN_NAME} instead.
 */
export const STREAM_HISTORY_MARKDOWN_NAME = "stream-history.md";

/** Filename when the full final assistant answer is attached as markdown. */
export const FINAL_RESPONSE_MARKDOWN_NAME = "response.md";

export function imageAttachmentsOf(
  attachments: ReadonlyArray<ChatAttachment> | null | undefined,
): ReadonlyArray<ChatImageAttachment> {
  if (attachments === undefined || attachments === null) return [];
  return attachments.filter((entry): entry is ChatImageAttachment => entry.type === "image");
}

export function unpostedAttachments(
  attachments: ReadonlyArray<ChatImageAttachment>,
  postedIds: ReadonlyArray<string>,
): ReadonlyArray<ChatImageAttachment> {
  const posted = new Set(postedIds);
  return attachments.filter((entry) => !posted.has(entry.id));
}

export function attachmentKey(attachments: ReadonlyArray<ChatImageAttachment>): string {
  return attachments.map((entry) => entry.id).join(",");
}

/**
 * True when the archived stream body has intermediate progress beyond the final answer.
 * Skip `stream-history.md` when the tip body is empty/placeholder or equals the final post
 * (single-bubble turns where message content already is the stream).
 */
export function streamHistoryHasAdditionalContent(historyText: string, finalText: string): boolean {
  const history = historyText.trim();
  if (history === "" || history === "…") return false;
  return history !== finalText.trim();
}

/**
 * Archive the in-progress stream as markdown text for a real Discord file attachment.
 * In-progress tips stay as live messages; this file is only the finalize archive.
 */
export function buildStreamHistoryMarkdownText(streamText: string): string | null {
  const body = streamText.trimEnd();
  if (body.trim() === "") return null;
  return [
    "# In-progress stream",
    "",
    "_Live tip updates from this turn (archived when the final answer was posted)._",
    "",
    body,
    "",
  ].join("\n");
}

/** @deprecated Use buildStreamHistoryMarkdownText + Discord multipart upload */
export function buildStreamHistoryMarkdownFile(streamText: string): File | null {
  const text = buildStreamHistoryMarkdownText(streamText);
  if (text === null) return null;
  return new File([text], STREAM_HISTORY_MARKDOWN_NAME, {
    type: "text/markdown;charset=utf-8",
  });
}

/**
 * Body for `response.md` when the full final answer is too long / table-heavy
 * for readable Discord message content.
 */
export function buildFinalResponseMarkdownText(text: string): string | null {
  const body = text.trimEnd();
  if (body.trim() === "") return null;
  return body.endsWith("\n") ? body : `${body}\n`;
}

/**
 * Short channel caption while the full body lives on `response.md`.
 * Prefer a short first heading/line when present; otherwise a neutral note.
 */
export function finalResponseCaption(text: string): string {
  const firstMeaningful = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (firstMeaningful === undefined) {
    return `Full response attached as \`${FINAL_RESPONSE_MARKDOWN_NAME}\`.`;
  }

  const stripped = firstMeaningful.replace(/^#{1,6}\s+/, "").trim();
  if (stripped.length > 0 && stripped.length <= 180) {
    return stripped;
  }
  return `Full response attached as \`${FINAL_RESPONSE_MARKDOWN_NAME}\`.`;
}

/**
 * Append a Discord masked [Omegent link](url) under the response.md caption.
 * No-op when the URL is missing (e.g. empty thread/message ids).
 */
export function withOmegentMessageLink(
  caption: string,
  omegentUrl: string | null | undefined,
): string {
  const url = omegentUrl?.trim() ?? "";
  if (url === "") return caption;
  const link = `[Omegent link](${url})`;
  const body = caption.trimEnd();
  if (body === "") return link;
  return `${body}\n\n${link}`;
}

/**
 * Long answers and any answer with GFM tables become `response.md`.
 * Short single-message finals without tables stay inline.
 */
export function shouldAttachFinalResponseAsMarkdown(input: {
  readonly text: string;
  readonly hasMarkdownTables: boolean;
  /** Chunk count after stats, if the full body were posted as message content. */
  readonly messageChunkCount: number;
}): boolean {
  if (input.text.trim() === "") return false;
  if (input.hasMarkdownTables) return true;
  return input.messageChunkCount > 1;
}
