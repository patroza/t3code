import type { ComposerImageAttachment } from "../../composerDraftStore";
import { randomUUID } from "../../lib/utils";

/**
 * Rebuilding composer attachments when a queued message is edited.
 *
 * A queued message's attachments name bytes the server holds — `{id, name,
 * mimeType, sizeBytes}` and nothing more. The composer needs the bytes
 * themselves (`File` + an object URL), so recalling a queued message for
 * editing has to fetch each attachment back through its signed asset URL.
 *
 * Callers must do this *before* removing the queued message. The removal is
 * what makes the edit destructive: once the queued entry is gone, a failed
 * fetch has no second chance and the picture is lost.
 */

export interface RecallableQueuedAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface QueuedAttachmentRecallResult {
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  /** Attachments whose bytes could not be fetched back, by display name. */
  readonly missing: ReadonlyArray<string>;
}

export interface QueuedAttachmentRecallDeps {
  /** Signed asset URL for an attachment id, when one has resolved yet. */
  readonly urlById: ReadonlyMap<string, string>;
  readonly fetchBlob: (url: string) => Promise<Blob>;
  readonly createObjectUrl: (file: File) => string;
}

export const defaultFetchAttachmentBlob = async (url: string): Promise<Blob> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Attachment request failed with status ${response.status}.`);
  }
  return await response.blob();
};

/**
 * Fetches every queued attachment back into a composer-ready image. Failures
 * are collected rather than thrown: one unreadable picture should not block
 * editing the message's text, and the caller reports what was left behind.
 */
export const recallQueuedAttachments = async (
  attachments: ReadonlyArray<RecallableQueuedAttachment>,
  deps: QueuedAttachmentRecallDeps,
): Promise<QueuedAttachmentRecallResult> => {
  const images: ComposerImageAttachment[] = [];
  const missing: string[] = [];

  for (const attachment of attachments) {
    const url = deps.urlById.get(attachment.id);
    if (!url) {
      missing.push(attachment.name);
      continue;
    }
    try {
      const blob = await deps.fetchBlob(url);
      // A fresh id keeps the recalled draft independent of the queued entry
      // that is about to be removed, matching how pasted images are staged.
      const file = new File([blob], attachment.name, {
        type: attachment.mimeType || blob.type,
      });
      images.push({
        type: "image",
        id: randomUUID(),
        name: attachment.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: deps.createObjectUrl(file),
        file,
      });
    } catch {
      missing.push(attachment.name);
    }
  }

  return { images, missing };
};

export const formatMissingAttachmentsError = (missing: ReadonlyArray<string>): string | null => {
  if (missing.length === 0) return null;
  return missing.length === 1
    ? `'${missing[0]}' could not be restored for editing and was left off the message.`
    : `${missing.length} attachments could not be restored for editing and were left off the message.`;
};
