import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  readToolOutputImage,
  toolOutputImageBlocks,
} from "@t3tools/shared/toolOutput";

const IMAGE_MIME_KEYS = ["mimeType", "mime_type", "media_type", "type"] as const;
const IMAGE_BODY_KEYS = new Set(["data", "blob", "base64"]);
const MAX_DEPTH = 32;
const MIN_BODY_LENGTH = 64;

type UnknownRecord = Record<string, unknown>;

function hasImageMime(record: UnknownRecord): boolean {
  return IMAGE_MIME_KEYS.some((key) => {
    const mime = record[key];
    return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
  });
}

function isImageBody(record: UnknownRecord, key: string | undefined): boolean {
  if (record.type === "image" || key === "image") return true;
  if (!hasImageMime(record)) return false;
  return (
    record.type === undefined ||
    record.type === "base64" ||
    (typeof record.type === "string" && record.type.toLowerCase().startsWith("image/"))
  );
}

function isBase64Char(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2b ||
    code === 0x2f ||
    code === 0x5f ||
    code === 0x2d
  );
}

// A regexp overflows V8's stack on a body near the 10 MiB image limit.
function isBase64Body(value: unknown): value is string {
  if (typeof value !== "string" || value.length < MIN_BODY_LENGTH) return false;
  let padding = 0;
  for (let index = value.length - 1; index >= 0 && value.charCodeAt(index) === 0x3d; index -= 1) {
    padding += 1;
    if (padding > 2) return false;
  }
  const end = value.length - padding;
  if (end === 0) return false;
  for (let index = 0; index < end; index += 1) {
    if (!isBase64Char(value.charCodeAt(index))) return false;
  }
  return true;
}

function base64DecodedLength(encoded: string): number {
  let length = encoded.length;
  while (length > 0 && encoded.charCodeAt(length - 1) === 0x3d) {
    length -= 1;
  }
  return Math.floor((length * 3) / 4);
}

interface StripContext {
  readonly output: unknown;
  served: ReadonlyArray<unknown> | undefined;
}

function isServed(context: StripContext, record: UnknownRecord): boolean {
  context.served ??= toolOutputImageBlocks(context.output);
  if (!context.served.includes(record)) return false;
  const data = readToolOutputImage(record)?.data;
  return data === undefined || data.length <= MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH;
}

function strip(
  value: unknown,
  key: string | undefined,
  context: StripContext,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    let next: Array<unknown> | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      const stripped = strip(entry, undefined, context, depth + 1);
      if (stripped !== entry) {
        next ??= value.slice();
        next[index] = stripped;
      }
    }
    return next ?? value;
  }
  const record = value as UnknownRecord;
  if (record.type === "image" && isServed(context, record)) return record;
  const imageBody = isImageBody(record, key);
  let next: UnknownRecord | undefined;
  let removedBody: string | undefined;
  for (const entryKey in record) {
    if (!Object.hasOwn(record, entryKey)) continue;
    const entry = record[entryKey];
    if (imageBody && IMAGE_BODY_KEYS.has(entryKey) && isBase64Body(entry)) {
      next ??= { ...record };
      delete next[entryKey];
      removedBody = entry;
      continue;
    }
    const stripped = strip(entry, entryKey, context, depth + 1);
    if (stripped !== entry) {
      next ??= { ...record };
      next[entryKey] = stripped;
    }
  }
  if (next !== undefined && removedBody !== undefined) {
    next.sizeBytes = base64DecodedLength(removedBody);
  }
  return next ?? record;
}

/** Image bytes are stored twice; retain only size-limited toolOutputImageBlocks that are served.
 * Read-file previews use viewedImagePath, and context handoffs skip tools. */
export function stripUnservedToolOutputImageBytes(
  item: OrchestrationV2TurnItem,
): OrchestrationV2TurnItem {
  if (item.type !== "dynamic_tool" || typeof item.output !== "object" || item.output === null) {
    return item;
  }
  const output = strip(item.output, undefined, { output: item.output, served: undefined }, 0);
  return output === item.output ? item : { ...item, output };
}
