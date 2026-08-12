import type { DraftComposerImageAttachment } from "./composerImages";
import { uuidv4 } from "./uuid";

/**
 * Rebuilding composer attachments when a server-queued message is edited.
 *
 * Server-queued attachments carry only `{id, name, mimeType, sizeBytes}`; the
 * bytes live on the server. Composer drafts need the bytes inline as a data
 * URL, so editing has to read each attachment back through its signed asset
 * URL first. Locally-queued (outbox) messages already hold their data URLs and
 * skip all of this.
 *
 * Read the bytes *before* removing the queued message — the removal is what
 * makes the edit destructive.
 */

export interface RecallableQueuedAttachment {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

export interface QueuedAttachmentRecallResult {
  readonly images: ReadonlyArray<DraftComposerImageAttachment>;
  /** Attachments whose bytes could not be read back, by display name. */
  readonly missing: ReadonlyArray<string>;
}

export interface QueuedAttachmentRecallDeps {
  readonly urlById: ReadonlyMap<string, string>;
  readonly fetchDataUrl: (url: string) => Promise<string>;
}

export const defaultFetchAttachmentDataUrl = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Attachment request failed with status ${response.status}.`);
  }
  const blob = await response.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => {
      reject(reader.error ?? new Error("Attachment could not be read."));
    };
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("Attachment could not be read."));
        return;
      }
      resolve(result);
    };
    reader.readAsDataURL(blob);
  });
};

/**
 * Reads every queued attachment back into a composer-ready draft image.
 * Failures are collected rather than thrown: one unreadable picture should not
 * block editing the message's text.
 */
export async function recallQueuedAttachments(
  attachments: ReadonlyArray<RecallableQueuedAttachment>,
  deps: QueuedAttachmentRecallDeps,
): Promise<QueuedAttachmentRecallResult> {
  const images: DraftComposerImageAttachment[] = [];
  const missing: string[] = [];

  for (const attachment of attachments) {
    const url = deps.urlById.get(attachment.id);
    if (!url) {
      missing.push(attachment.name);
      continue;
    }
    try {
      const dataUrl = await deps.fetchDataUrl(url);
      images.push({
        // A fresh id keeps the recalled draft independent of the queued entry
        // that is about to be removed, matching how picked images are staged.
        id: uuidv4(),
        type: "image",
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
        dataUrl,
        previewUri: dataUrl,
      });
    } catch {
      missing.push(attachment.name);
    }
  }

  return { images, missing };
}

export function formatMissingAttachmentsError(missing: ReadonlyArray<string>): string | null {
  if (missing.length === 0) return null;
  return missing.length === 1
    ? `'${missing[0]}' could not be restored for editing and was left off the message.`
    : `${missing.length} attachments could not be restored for editing and were left off the message.`;
}
