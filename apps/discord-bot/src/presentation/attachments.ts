import type { ChatAttachment, ChatImageAttachment } from "@t3tools/contracts";

/** Discord allows up to 10 files per message. */
export const DISCORD_MAX_FILES_PER_MESSAGE = 10;

/**
 * Filename for the archived in-progress stream (hidden after finalize).
 * The final answer itself is posted as normal Discord message content.
 */
export const STREAM_HISTORY_MARKDOWN_NAME = "stream-history.md";

/**
 * Channel-topic tag that opts a channel into the in-progress stream attachment.
 * `omegent-ips` is canonical. Legacy `t3-ips` still opts in.
 * Threads have no topic of their own; callers pass the parent channel topic.
 */
export const IN_PROGRESS_STREAM_TOPIC_TAG = "omegent-ips";

const IN_PROGRESS_STREAM_TOPIC_TAG_PATTERN = /\b(?:omegent|t3)-ips\b/iu;

/** True when `topic` contains `omegent-ips` or the legacy `t3-ips` tag. */
export function channelTopicOptsIntoInProgressStream(topic: string | null | undefined): boolean {
  if (topic === null || topic === undefined) return false;
  return IN_PROGRESS_STREAM_TOPIC_TAG_PATTERN.test(topic);
}

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
 * Attach `stream-history.md` only for an opted-in channel, and only when the
 * archived stream has intermediate progress beyond the final answer.
 */
export function shouldAttachStreamHistory(input: {
  readonly channelTopicOptIn: boolean;
  readonly alreadyPosted: boolean;
  readonly hadStreamMessages: boolean;
  readonly historyText: string;
  readonly finalText: string;
}): boolean {
  return (
    input.channelTopicOptIn &&
    !input.alreadyPosted &&
    input.hadStreamMessages &&
    streamHistoryHasAdditionalContent(input.historyText, input.finalText)
  );
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
 * Same-line ` · [Open](url)` — clickable Discord markdown, short label.
 * Used on the stats footer of every final answer.
 */
export function withT3DeepLink(caption: string, t3Url: string | null | undefined): string {
  const url = t3Url?.trim() ?? "";
  if (url === "") return caption;
  const link = `[Open](${url})`;
  const body = caption.trimEnd();
  if (body === "") return link;
  return `${body} · ${link}`;
}

/**
 * Append a T3 deep link onto the last message chunk (the stats footer),
 * respecting the Discord limit. Always used on finals when a URL is available.
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
