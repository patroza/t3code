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

/**
 * Append a compact T3 deep link on a Discord caption/chunk.
 * Same-line ` · [T3](url)` — clickable Discord markdown, short label.
 */
export function withT3DeepLink(caption: string, t3Url: string | null | undefined): string {
  const url = t3Url?.trim() ?? "";
  if (url === "") return caption;
  const link = `[T3](${url})`;
  const body = caption.trimEnd();
  if (body === "") return link;
  return `${body} · ${link}`;
}

/**
 * When the final answer would need multi-message chunking or contains GFM tables,
 * surface a T3 deep link so the full rendered answer is one click away.
 * Short single-message prose without tables stays link-free.
 */
export function shouldAttachT3DeepLink(input: {
  readonly text: string;
  readonly hasMarkdownTables: boolean;
  readonly messageChunkCount: number;
}): boolean {
  if (input.text.trim() === "") return false;
  if (input.hasMarkdownTables) return true;
  return input.messageChunkCount > 1;
}

/**
 * Append a T3 deep link onto the last message chunk, respecting the Discord limit.
 * If the link would overflow the last chunk, emit it as its own trailing chunk.
 */
export function appendT3DeepLinkToChunks(
  chunks: ReadonlyArray<string>,
  t3Url: string | null | undefined,
  limit: number,
): string[] {
  const url = t3Url?.trim() ?? "";
  if (url === "" || chunks.length === 0) return [...chunks];

  const out = [...chunks];
  const lastIndex = out.length - 1;
  const last = out[lastIndex] ?? "";
  const linked = withT3DeepLink(last, url);
  if (linked.length <= limit) {
    out[lastIndex] = linked;
    return out;
  }

  const solo = withT3DeepLink("", url);
  if (solo.length <= limit) {
    out.push(solo);
  }
  return out;
}
