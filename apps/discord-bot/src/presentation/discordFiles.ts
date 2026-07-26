/**
 * Discord file uploads must use multipart createMessage:
 *   - payload_json: { content, attachments: [{ id: 0, filename }] }
 *   - files[0], files[1], ...
 *
 * Attachments cannot be added later via message edit.
 */
// @effect-diagnostics globalFetch:off globalFetchInEffect:off unknownInEffectCatch:off anyUnknownInErrorContext:off preferSchemaOverJson:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off missingEffectError:off

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
}): Promise<{ readonly id: string }> {
  const content = input.content;
  const files = input.files;

  const form = new FormData();
  const payload: {
    content: string;
    attachments?: ReadonlyArray<{ id: number; filename: string }>;
  } = {
    content,
  };

  if (files.length > 0) {
    payload.attachments = files.map((file, index) => ({
      id: index,
      filename: file.name,
    }));
  }

  // Discord rejects completely empty messages; allow empty content when files exist.
  if (payload.content.trim() === "" && files.length === 0) {
    payload.content = "\u200b";
  }

  // payload_json must be a field name Discord recognizes — not an attachment.
  form.append("payload_json", JSON.stringify(payload));

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
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

  // Strip trailing slash so we don't double up.
  const base = input.baseUrl.replace(/\/+$/, "");
  const url = `${base}/channels/${input.channelId}/messages`;

  // Prefer global fetch (Node undici over HTTP/1.1) — Effect's layerUndici + HTTP/2
  // multipart has been observed to fail with NGHTTP2_PROTOCOL_ERROR on ~1MB images.
  const response = await globalThis.fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bot ${input.botToken}`,
      "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
    },
    body: form,
  });

  if (!response.ok) {
    const errBody = await response.text().catch(() => "");
    throw new DiscordUploadError(
      `Discord createMessage with files failed (${response.status}): ${errBody}`,
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
