// @effect-diagnostics globalFetch:off globalPromise:off globalDate:off nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import {
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  isProviderSendTurnSupportedImageMimeType,
  type UploadChatAttachment,
} from "@t3tools/contracts";

export const TEAMS_TURN_MAX_IMAGES = 8;
const GRAPH_ORIGIN = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const BOT_SCOPE = "https://api.botframework.com/.default";
const FILE_DOWNLOAD = "application/vnd.microsoft.teams.file.download.info";
const NOTE_TEXT_MAX = 2000;

export interface TeamsActivityAttachment {
  readonly contentType?: string | undefined;
  readonly contentUrl?: string | undefined;
  readonly thumbnailUrl?: string | undefined;
  readonly name?: string | undefined;
  readonly content?: unknown;
}

export interface TeamsTurnImageRequest {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly messageId: string;
  readonly replyToId?: string | undefined;
  readonly plainText?: string | undefined;
  readonly location:
    | { readonly kind: "channel"; readonly teamId: string; readonly channelId: string }
    | { readonly kind: "chat"; readonly conversationId: string };
  readonly attachments?: ReadonlyArray<TeamsActivityAttachment> | undefined;
  readonly fetch?: typeof globalThis.fetch | undefined;
  readonly tokens?: { readonly graph?: string | undefined; readonly bot?: string | undefined };
  readonly tokenCache?: Map<string, { token: string; expiresAt: number }> | undefined;
}

export interface TeamsTurnImageLoad {
  readonly uploads: ReadonlyArray<UploadChatAttachment>;
  readonly note: string;
  readonly warnings: ReadonlyArray<string>;
}

interface FetchedBody {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

const processTokenCache = new Map<string, { token: string; expiresAt: number }>();

function mediaType(value: string | null | undefined): string {
  return value?.split(";")[0]?.trim().toLowerCase() ?? "";
}

function safeName(name: string, fallback: string): string {
  const cleaned = name
    .replace(/[\r\n]/gu, " ")
    .trim()
    .slice(0, 255);
  return cleaned.length > 0 ? cleaned : fallback;
}

function extensionMime(name: string): string | null {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
    }[extension] ?? null
  );
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

function imageMime(header: string | null | undefined, bytes: Uint8Array, name = ""): string | null {
  const sniffed = sniffImageMime(bytes);
  if (sniffed !== null && isProviderSendTurnSupportedImageMimeType(sniffed)) return sniffed;
  // Non-empty bytes that do not sniff as an image are not uploaded under a declared type.
  if (bytes.byteLength > 0) return null;
  const declared = mediaType(header);
  if (isProviderSendTurnSupportedImageMimeType(declared)) return declared;
  const fromName = extensionMime(name);
  return fromName !== null && isProviderSendTurnSupportedImageMimeType(fromName) ? fromName : null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isGraphUrl(value: string): boolean {
  try {
    return new URL(value).hostname === "graph.microsoft.com";
  } catch {
    return false;
  }
}

function dataImage(value: string | undefined): { mime: string; bytes: Uint8Array } | null {
  if (value === undefined || !value.startsWith("data:")) return null;
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\s]+)$/iu.exec(value);
  if (match === null) return null;
  const mime = match[1]!.toLowerCase();
  if (!isProviderSendTurnSupportedImageMimeType(mime)) return null;
  const bytes = new Uint8Array(Buffer.from(match[2]!.replace(/\s+/gu, ""), "base64"));
  return bytes.byteLength > 0 ? { mime, bytes } : null;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (_, digits: string) => {
      const code = Number(digits);
      return Number.isInteger(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/&nbsp;/giu, " ")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">")
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&amp;/giu, "&");
}

function htmlToText(value: string): string {
  const withoutBlocks = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, " ");
  return decodeEntities(withoutBlocks.replace(/<[^>]+>/gu, " "))
    .replace(/\s+/gu, " ")
    .trim();
}

function quotedAttachmentText(
  attachment: TeamsActivityAttachment,
  plainText: string,
): string | null {
  const type = mediaType(attachment.contentType);
  if (type !== "text/html" && type !== "text/plain") return null;
  if (typeof attachment.content !== "string") return null;
  const text =
    type === "text/html"
      ? htmlToText(attachment.content)
      : attachment.content.replace(/\s+/gu, " ").trim();
  if (text.length === 0) return null;
  const plain = plainText.replace(/\s+/gu, " ").trim();
  if (plain.length === 0) return text.slice(0, NOTE_TEXT_MAX);
  if (text === plain) return null;
  const remainder = text.includes(plain)
    ? text.replace(plain, " ").replace(/\s+/gu, " ").trim()
    : text;
  return remainder.length === 0 ? null : remainder.slice(0, NOTE_TEXT_MAX);
}

function contentRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function chatId(conversationId: string): string {
  const bare = conversationId.split(";messageid=")[0] ?? conversationId;
  return bare.trim();
}

/** teamId and channelId are the Entra group id and the 19: channel id. */
function hostedContentsUrl(input: TeamsTurnImageRequest): string {
  const messageId = encodeURIComponent(input.messageId);
  if (input.location.kind === "channel") {
    const base = `${GRAPH_ORIGIN}/teams/${encodeURIComponent(input.location.teamId)}/channels/${encodeURIComponent(input.location.channelId)}/messages`;
    return input.replyToId === undefined
      ? `${base}/${messageId}/hostedContents`
      : `${base}/${encodeURIComponent(input.replyToId)}/replies/${messageId}/hostedContents`;
  }
  const base = `${GRAPH_ORIGIN}/chats/${encodeURIComponent(chatId(input.location.conversationId))}/messages`;
  return input.replyToId === undefined
    ? `${base}/${messageId}/hostedContents`
    : `${base}/${encodeURIComponent(input.replyToId)}/replies/${messageId}/hostedContents`;
}

export async function fetchMicrosoftAppToken(input: {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scope: string;
  readonly fetchImpl: typeof globalThis.fetch;
  readonly cache: Map<string, { token: string; expiresAt: number }>;
  readonly now?: number | undefined;
}): Promise<string | null> {
  const key = `${input.tenantId}\n${input.clientId}\n${input.scope}`;
  const now = input.now ?? Date.now();
  const cached = input.cache.get(key);
  if (cached !== undefined && cached.expiresAt > now + 60_000) return cached.token;
  let response: Response;
  try {
    response = await input.fetchImpl(
      `https://login.microsoftonline.com/${encodeURIComponent(input.tenantId)}/oauth2/v2.0/token`,
      {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: input.clientId,
          client_secret: input.clientSecret,
          grant_type: "client_credentials",
          scope: input.scope,
        }),
      },
    );
  } catch {
    return null;
  }
  if (!response.ok) return null;
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return null;
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const token = record.access_token;
  if (typeof token !== "string" || token.length === 0) return null;
  const expiresIn = typeof record.expires_in === "number" ? record.expires_in : 3600;
  input.cache.set(key, { token, expiresAt: now + expiresIn * 1000 });
  return token;
}

async function fetchBody(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  authorization: string | null,
): Promise<FetchedBody | null> {
  let current = url;
  let auth = authorization;
  for (let hop = 0; hop < 3; hop += 1) {
    let response: Response;
    try {
      response = await fetchImpl(current, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
        ...(auth === null ? {} : { headers: { authorization: auth } }),
      });
    } catch {
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel().catch(() => undefined);
      if (location === null)
        return { status: response.status, bytes: new Uint8Array(), contentType: null };
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return { status: response.status, bytes: new Uint8Array(), contentType: null };
      }
      if (next.protocol !== "https:") {
        return { status: response.status, bytes: new Uint8Array(), contentType: null };
      }
      if (next.host !== new URL(current).host) auth = null;
      current = next.toString();
      continue;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return { status: response.status, bytes, contentType: response.headers.get("content-type") };
  }
  return null;
}

function decodeContentBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const bytes = new Uint8Array(Buffer.from(value.replace(/\s+/gu, ""), "base64"));
  return bytes.byteLength > 0 ? bytes : null;
}

export async function loadTeamsTurnImages(
  input: TeamsTurnImageRequest,
): Promise<TeamsTurnImageLoad> {
  const fetchImpl = input.fetch ?? globalThis.fetch;
  const cache = input.tokenCache ?? processTokenCache;
  const uploads: UploadChatAttachment[] = [];
  const unopened: string[] = [];
  const quoted: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let omittedImages = 0;

  const considerImage = (name: string, mime: string | null, bytes: Uint8Array): boolean => {
    const resolved = mime !== null && isProviderSendTurnSupportedImageMimeType(mime) ? mime : null;
    if (resolved === null || bytes.byteLength === 0) return false;
    if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      unopened.push(safeName(name, "teams-image"));
      return true;
    }
    const digest = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
    if (seen.has(digest)) return true;
    seen.add(digest);
    if (uploads.length >= TEAMS_TURN_MAX_IMAGES) {
      omittedImages += 1;
      return true;
    }
    uploads.push({
      type: "image",
      name: safeName(name, "teams-image"),
      mimeType: resolved,
      sizeBytes: bytes.byteLength,
      dataUrl: `data:${resolved};base64,${Buffer.from(bytes).toString("base64")}`,
    });
    return true;
  };

  const graphToken =
    input.tokens?.graph ??
    (await fetchMicrosoftAppToken({
      tenantId: input.tenantId,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      scope: GRAPH_SCOPE,
      fetchImpl,
      cache,
    }));
  if (graphToken === null) warnings.push("Microsoft Graph token request failed");

  if (graphToken !== null) {
    const collectionUrl = hostedContentsUrl(input);
    const collection = await fetchBody(fetchImpl, collectionUrl, `Bearer ${graphToken}`);
    if (collection === null) {
      warnings.push("Teams hosted contents failed");
    } else if (collection.status === 404) {
      /* This message has no hosted images. */
    } else if (collection.status !== 200) {
      warnings.push(`Teams hosted contents failed (${collection.status})`);
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(collection.bytes).toString("utf8")) as unknown;
      } catch {
        parsed = null;
      }
      const value =
        parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>).value
          : null;
      const entries = Array.isArray(value) ? value : [];
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const record = entry as Record<string, unknown>;
        const id = stringField(record, "id");
        if (id === null) continue;
        const declared = stringField(record, "contentType");
        const inline = decodeContentBytes(record.contentBytes);
        const body =
          inline !== null
            ? { status: 200, bytes: inline, contentType: declared }
            : await fetchBody(
                fetchImpl,
                `${collectionUrl}/${encodeURIComponent(id)}/$value`,
                `Bearer ${graphToken}`,
              );
        if (body === null || body.status !== 200) {
          warnings.push("Teams hosted image failed");
          continue;
        }
        const mime = imageMime(body.contentType ?? declared, body.bytes);
        if (mime === null) continue;
        const extension = mime.split("/")[1]?.replace(/[^a-z0-9]+/giu, "") || "png";
        considerImage(`teams-inline-${id}.${extension}`, mime, body.bytes);
      }
    }
  }

  let botToken: string | null | undefined = input.tokens?.bot;
  const authorizationFor = async (url: string): Promise<string | null> => {
    if (isGraphUrl(url)) return graphToken === null ? null : `Bearer ${graphToken}`;
    if (botToken === undefined) {
      botToken = await fetchMicrosoftAppToken({
        tenantId: input.tenantId,
        clientId: input.clientId,
        clientSecret: input.clientSecret,
        scope: BOT_SCOPE,
        fetchImpl,
        cache,
      });
      if (botToken === null) warnings.push("Microsoft bot token request failed");
    }
    return botToken === null ? null : `Bearer ${botToken}`;
  };

  const downloadImage = async (url: string, name: string): Promise<boolean> => {
    const embedded = dataImage(url);
    if (embedded !== null) return considerImage(name, embedded.mime, embedded.bytes);
    const target = httpsUrl(url);
    if (target === null) return false;
    const graph = isGraphUrl(target);
    let body = await fetchBody(fetchImpl, target, await authorizationFor(target));
    if (!graph && body !== null && (body.status === 401 || body.status === 403)) {
      body = await fetchBody(fetchImpl, target, null);
    }
    if (body === null || body.status !== 200) {
      warnings.push(
        body === null
          ? "Teams image download failed"
          : `Teams image download failed (${body.status})`,
      );
      return false;
    }
    return considerImage(name, imageMime(body.contentType, body.bytes, name), body.bytes);
  };

  for (const attachment of input.attachments ?? []) {
    const type = mediaType(attachment.contentType);
    const quote = quotedAttachmentText(attachment, input.plainText ?? "");
    if (quote !== null) quoted.push(quote);
    if (type === FILE_DOWNLOAD) {
      const content = contentRecord(attachment.content);
      const name = safeName(
        attachment.name ??
          (content === null ? null : stringField(content, "fileName")) ??
          "teams-file",
        "teams-file",
      );
      const fileType = content === null ? null : stringField(content, "fileType");
      const declared = extensionMime(fileType ? `file.${fileType}` : name);
      const downloadUrl = content === null ? null : httpsUrl(stringField(content, "downloadUrl"));
      if (declared !== null && downloadUrl !== null) {
        const body = await fetchBody(fetchImpl, downloadUrl, null);
        if (body !== null && body.status === 200) {
          if (!considerImage(name, imageMime(body.contentType, body.bytes, name), body.bytes)) {
            unopened.push(name);
          }
          continue;
        }
        warnings.push(
          body === null
            ? "Teams file download failed"
            : `Teams file download failed (${body.status})`,
        );
      }
      unopened.push(name);
      continue;
    }
    if (type.startsWith("image/") && !isProviderSendTurnSupportedImageMimeType(type)) {
      unopened.push(safeName(attachment.name ?? "teams-image", "teams-image"));
      continue;
    }
    const name = safeName(attachment.name ?? "teams-image", "teams-image");
    const declared = imageMime(type.startsWith("image/") ? type : null, new Uint8Array(), name);
    if (declared === null) continue;
    const urls = [attachment.contentUrl, attachment.thumbnailUrl].filter(
      (url): url is string => typeof url === "string" && url.trim().length > 0,
    );
    let opened = false;
    for (const url of urls) {
      if (await downloadImage(url, name)) {
        opened = true;
        break;
      }
    }
    if (!opened && urls.length > 0) unopened.push(name);
  }

  const lines: string[] = [];
  if (uploads.length > 0) {
    lines.push(`Teams screenshots attached: ${uploads.map((upload) => upload.name).join(", ")}`);
  }
  if (omittedImages > 0) lines.push(`${omittedImages} additional Teams images were left out.`);
  if (unopened.length > 0) {
    lines.push(`Teams attached files that were not opened: ${unopened.join(", ")}`);
  }
  if (quoted.length > 0) lines.push(`Quoted Teams attachment text:\n${quoted.join("\n\n")}`);
  return { uploads, note: lines.join("\n\n").slice(0, 4000), warnings };
}
