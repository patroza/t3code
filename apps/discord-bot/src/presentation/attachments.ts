import type { ChatAttachment, ChatImageAttachment } from "@t3tools/contracts";

/** Discord allows up to 10 files per message. */
export const DISCORD_MAX_FILES_PER_MESSAGE = 10;

/**
 * Filename for the archived in-progress stream (hidden after finalize).
 * The final answer itself is posted as normal Discord message content.
 */
export const STREAM_HISTORY_MARKDOWN_NAME = "stream-history.md";

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
 * Final answer stays in Discord message content (chunked if needed).
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
