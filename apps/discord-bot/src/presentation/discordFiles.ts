/**
 * Discord file uploads must use multipart createMessage:
 *   - payload_json: { content, attachments: [{ id: 0, filename }] }
 *   - files[0], files[1], ...
 *
 * Attachments cannot be added later via message edit.
 */
// @effect-diagnostics globalFetch:off globalFetchInEffect:off unknownInEffectCatch:off anyUnknownInErrorContext:off preferSchemaOverJson:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off missingEffectError:off

import { interactionMessageFlags, SUPPRESS_EMBEDS_FLAG } from "./suppressEmbeds.ts";

export interface DiscordUploadFile {
  readonly name: string;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

export class DiscordUploadError extends Error {
  readonly status: number | undefined;
  readonly body: string | undefined;

  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.name = "DiscordUploadError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Create a channel message with binary attachments in a single multipart POST.
 * Pure async helper — pass bot token + baseUrl from DiscordConfig at the call site.
 */
export async function createMessageWithAttachments(input: {
  readonly baseUrl: string;
  readonly botToken: string;
  readonly channelId: string;
  readonly content: string;
  readonly files: ReadonlyArray<DiscordUploadFile>;
  /** Discord `allowed_mentions`; pass `{ parse: [] }` for untrusted content. */
  readonly allowedMentions?: { readonly parse: ReadonlyArray<"users" | "roles" | "everyone"> };
}): Promise<{ readonly id: string }> {
  const base = input.baseUrl.replace(/\/+$/, "");
  const json = await sendDiscordMultipart({
    ...(input.allowedMentions !== undefined ? { allowedMentions: input.allowedMentions } : {}),
    url: `${base}/channels/${input.channelId}/messages`,
    botToken: input.botToken,
    method: "POST",
    content: input.content,
    flags: SUPPRESS_EMBEDS_FLAG,
    files: input.files,
    failure: "Discord createMessage with files failed",
  });
  return { id: json.id };
}

/**
 * Replace the deferred interaction response, including an ephemeral file.
 * Interaction webhook edits authenticate with the interaction token in the URL.
 * The bot token is still sent because the rest of this process does that for
 * webhook edits and Discord accepts it for this application.
 */
export async function editOriginalInteractionWithAttachments(input: {
  readonly baseUrl: string;
  readonly botToken: string;
  readonly applicationId: string;
  readonly interactionToken: string;
  readonly content: string;
  readonly files: ReadonlyArray<DiscordUploadFile>;
}): Promise<void> {
  const base = input.baseUrl.replace(/\/+$/, "");
  await sendDiscordMultipart({
    url: `${base}/webhooks/${input.applicationId}/${input.interactionToken}/messages/@original`,
    botToken: input.botToken,
    method: "PATCH",
    content: input.content,
    flags: interactionMessageFlags({ ephemeral: true }),
    files: input.files,
    failure: "Discord interaction attachment edit failed",
  });
}

async function sendDiscordMultipart(input: {
  readonly url: string;
  readonly botToken: string;
  readonly method: "POST" | "PATCH";
  readonly content: string;
  readonly flags: number;
  readonly files: ReadonlyArray<DiscordUploadFile>;
  readonly failure: string;
  readonly allowedMentions?: { readonly parse: ReadonlyArray<"users" | "roles" | "everyone"> };
}): Promise<{ readonly id: string }> {
  const form = new FormData();
  const payload: {
    content: string;
    flags: number;
    attachments?: ReadonlyArray<{ id: number; filename: string }>;
    allowed_mentions?: { readonly parse: ReadonlyArray<"users" | "roles" | "everyone"> };
  } = {
    content: input.content,
    // Suppress link embeds; attachments (files[]) are separate and unaffected.
    flags: input.flags,
    ...(input.allowedMentions !== undefined ? { allowed_mentions: input.allowedMentions } : {}),
  };

  if (input.files.length > 0) {
    payload.attachments = input.files.map((file, index) => ({
      id: index,
      filename: file.name,
    }));
  }

  // Discord rejects completely empty messages; allow empty content when files exist.
  if (payload.content.trim() === "" && input.files.length === 0) {
    payload.content = "\u200b";
  }

  // payload_json must be a field name Discord recognizes — not an attachment.
  form.append("payload_json", JSON.stringify(payload));

  for (let index = 0; index < input.files.length; index += 1) {
    const file = input.files[index]!;
    // Copy into a plain ArrayBuffer-backed Uint8Array for BlobPart typing.
    const copy = new Uint8Array(file.data.byteLength);
    copy.set(file.data);
    // Prefer File (filename is first-class). Blob+filename can show up as "blob"
    // in some Discord clients when the multipart disposition is incomplete.
    const safeName =
      file.name.trim() !== ""
        ? file.name.trim()
        : file.mimeType.startsWith("image/")
          ? "image.png"
          : "attachment.bin";
    form.append(
      `files[${index}]`,
      new File([copy], safeName, {
        type: file.mimeType || "application/octet-stream",
      }),
    );
  }

  // Prefer global fetch (Node undici over HTTP/1.1) — Effect's layerUndici + HTTP/2
  // multipart has been observed to fail with NGHTTP2_PROTOCOL_ERROR on ~1MB images.
  const response = await globalThis.fetch(input.url, {
    method: input.method,
    headers: {
      Authorization: `Bot ${input.botToken}`,
      "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
    },
    body: form,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new DiscordUploadError(
      `${input.failure} (${response.status}): ${errBody}`,
      response.status,
      errBody,
    );
  }

  const json = (await response.json()) as { readonly id: string };
  return { id: json.id };
}

export function textFile(
  name: string,
  text: string,
  mimeType = "text/markdown;charset=utf-8",
): DiscordUploadFile {
  return {
    name,
    mimeType,
    data: new TextEncoder().encode(text),
  };
}
