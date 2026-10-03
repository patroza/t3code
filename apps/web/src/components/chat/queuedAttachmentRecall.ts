import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";

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
 * what makes the edit destructive: once the queued entry is gone, its
 * attachment files are pruned server-side and a failed fetch has no second
 * chance — so a caller that cannot restore everything must leave the message
 * queued rather than remove it.
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
 * are collected rather than thrown so the caller sees the whole picture at
 * once: because removing the queued message prunes its files, a caller that
 * cannot restore everything must abandon the edit rather than restore part.
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
    ? `'${missing[0]}' could not be loaded, so the message is still queued. Try again — if it keeps failing, the image is no longer on the server and the message has to be sent or replaced as it is.`
    : `${missing.length} attachments could not be loaded, so the message is still queued. Try again — if it keeps failing, the image is no longer on the server and the message has to be sent or replaced as it is.`;
};

/**
 * Refuses the edit up front when the composer has no room for the queued
 * message's pictures. Restoring only some of them would drop the rest for good,
 * since removing the queued message deletes its attachment files server-side.
 */
export const describeQueuedAttachmentCapacity = (
  queuedCount: number,
  draftImageCount: number,
): string | null => {
  if (queuedCount === 0) return null;
  const capacity = Math.max(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - draftImageCount);
  if (queuedCount <= capacity) return null;
  return `Editing this message would bring back ${queuedCount} image${
    queuedCount === 1 ? "" : "s"
  }, past the ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-image limit. Remove some images from the composer first.`;
};
