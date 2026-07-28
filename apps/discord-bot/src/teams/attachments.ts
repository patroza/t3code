// @effect-diagnostics globalFetch:off
import type { UploadChatAttachment } from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";

import type { DiscordUploadFile } from "../presentation/discordFiles.ts";
import type { TeamsMessage } from "./presentation.ts";

export interface TeamsImageDownloadResult {
  readonly discordFiles: ReadonlyArray<DiscordUploadFile>;
  readonly t3Uploads: ReadonlyArray<UploadChatAttachment>;
  readonly skipped: ReadonlyArray<{
    readonly name: string;
    readonly reason: string;
  }>;
}

function extensionFromName(name: string): string {
  const match = /\.([a-z0-9]+)$/iu.exec(name.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

function guessImageMimeType(input: {
  readonly name: string;
  readonly contentType?: string | undefined;
}): string | null {
  const contentType = input.contentType?.trim().toLowerCase();
  if (contentType?.startsWith("image/")) return contentType;

  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      bmp: "image/bmp",
      svg: "image/svg+xml",
      heic: "image/heic",
      heif: "image/heif",
    }[extensionFromName(input.name)] ?? null
  );
}

function base64DataUrl(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}

async function fetchBytes(input: {
  readonly url: string;
  readonly accessToken?: string | undefined;
}): Promise<Uint8Array> {
  const withAuth = input.accessToken
    ? ({
        authorization: `Bearer ${input.accessToken}`,
      } satisfies HeadersInit)
    : undefined;
  const response = await globalThis.fetch(input.url, withAuth ? { headers: withAuth } : undefined);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function downloadTeamsMessageImages(input: {
  readonly message: TeamsMessage;
  readonly accessToken: string;
  readonly hostedContentEntries: ReadonlyArray<{
    readonly id: string;
    readonly contentType?: string | undefined;
    readonly valueUrl: string;
  }>;
}): Promise<TeamsImageDownloadResult> {
  const discordFiles: DiscordUploadFile[] = [];
  const t3Uploads: UploadChatAttachment[] = [];
  const skipped: Array<{ readonly name: string; readonly reason: string }> = [];

  const pushImage = (name: string, mimeType: string, bytes: Uint8Array) => {
    discordFiles.push({
      name,
      mimeType,
      data: bytes,
    });
    if (bytes.byteLength <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      t3Uploads.push({
        type: "image",
        name,
        mimeType,
        sizeBytes: bytes.byteLength,
        dataUrl: base64DataUrl(bytes, mimeType),
      });
    } else {
      skipped.push({
        name,
        reason: `too large for T3 upload (${bytes.byteLength} bytes)`,
      });
    }
  };

  for (const attachment of input.message.attachments ?? []) {
    const name = attachment.name?.trim() || "teams-image";
    const mimeType = guessImageMimeType({
      name,
      contentType: attachment.contentType,
    });
    const url = attachment.contentUrl ?? attachment.thumbnailUrl ?? "";
    if (mimeType === null || url.trim() === "") continue;

    try {
      const bytes = await fetchBytes({
        url,
        accessToken: input.accessToken,
      });
      pushImage(name, mimeType, bytes);
    } catch (error) {
      skipped.push({
        name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const hostedContent of input.hostedContentEntries) {
    const mimeType = hostedContent.contentType?.trim().toLowerCase();
    if (!mimeType?.startsWith("image/")) continue;

    const extension = mimeType.split("/")[1]?.replace(/[^a-z0-9]+/giu, "") || "png";
    const name = `teams-inline-${hostedContent.id}.${extension}`;
    try {
      const bytes = await fetchBytes({
        url: hostedContent.valueUrl,
        accessToken: input.accessToken,
      });
      pushImage(name, mimeType, bytes);
    } catch (error) {
      skipped.push({
        name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    discordFiles,
    t3Uploads,
    skipped,
  };
}
