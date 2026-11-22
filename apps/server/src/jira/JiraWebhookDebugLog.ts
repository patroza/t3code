import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { ServerConfig } from "../config.ts";

/** Retain webhook debug rows for at most one day. */
const WEBHOOK_DEBUG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Safety cap so a flood cannot grow a source file without bound. */
const WEBHOOK_DEBUG_MAX_RECORDS = 5_000;
/** Cap stored request body previews (invalid/ignored diagnosis). */
const WEBHOOK_DEBUG_BODY_PREVIEW_CHARS = 4_000;

/** Inbound integration webhook sources that write debug NDJSON. */
export type WebhookSource = "jira";

const WEBHOOK_DEBUG_SOURCES = ["jira"] as const satisfies ReadonlyArray<WebhookSource>;

function webhookDebugFilename(source: WebhookSource): string {
  return `${source}-webhook-debug.ndjson`;
}

/** Outcome tags for the Jira webhook handler. */
export type WebhookDebugOutcome =
  | "disabled_404"
  | "too_large_413"
  | "unauthorized_401"
  | "invalid_400"
  | "missing_delivery_id_400"
  | "ignored_202"
  | "project_denied_202"
  | "accepted_202";

export interface WebhookDebugRecord {
  readonly ts: string;
  readonly source: WebhookSource;
  readonly outcome: WebhookDebugOutcome;
  readonly status: number;
  readonly reason?: string;
  readonly bodyBytes: number;
  readonly bodyPreview?: string;
  readonly deliveryId?: string;
  readonly webhookEvent?: string;
  readonly mention?: string;
  readonly commentSurface?: string;
  readonly issueKey?: string;
  readonly projectKey?: string;
  readonly commentId?: string;
  readonly prompt?: string;
  readonly commentText?: string;
  readonly actorDisplayName?: string | null;
  readonly actorAccountId?: string | null;
}

export type WebhookDebugAppendInput = Omit<WebhookDebugRecord, "ts"> & {
  readonly ts?: string;
};

export function previewWebhookBody(
  body: string,
  maxChars: number = WEBHOOK_DEBUG_BODY_PREVIEW_CHARS,
): { readonly bodyBytes: number; readonly bodyPreview: string } {
  const bodyBytes = new TextEncoder().encode(body).byteLength;
  if (body.length <= maxChars) {
    return { bodyBytes, bodyPreview: body };
  }
  return {
    bodyBytes,
    bodyPreview: `${body.slice(0, maxChars)}…`,
  };
}

/**
 * Classify why a raw webhook body failed decode.
 * Distinguishes broken JSON (common for Automation custom data with raw newlines)
 * from schema mismatches on otherwise valid JSON.
 */
export function classifyWebhookBodyFailure(body: string): {
  readonly reason: "json_parse_failed" | "schema_decode_failed" | "empty_body";
  readonly detail?: string;
} {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return { reason: "empty_body" };
  }
  try {
    JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { reason: "json_parse_failed", detail: detail.slice(0, 300) };
  }
  return { reason: "schema_decode_failed" };
}

export function pruneWebhookDebugRecords(
  records: ReadonlyArray<WebhookDebugRecord>,
  nowMs: number,
  maxAgeMs: number = WEBHOOK_DEBUG_MAX_AGE_MS,
  maxRecords: number = WEBHOOK_DEBUG_MAX_RECORDS,
): WebhookDebugRecord[] {
  const cutoff = nowMs - maxAgeMs;
  const kept = records.filter((record) => {
    const ms = Date.parse(record.ts);
    if (Number.isNaN(ms)) return false;
    return ms >= cutoff;
  });
  if (kept.length <= maxRecords) return kept;
  // Keep the newest N when over the hard cap.
  return kept.slice(kept.length - maxRecords);
}

function parseDebugNdjson(raw: string): WebhookDebugRecord[] {
  const records: WebhookDebugRecord[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "ts" in parsed &&
        typeof (parsed as { ts: unknown }).ts === "string" &&
        "outcome" in parsed &&
        typeof (parsed as { outcome: unknown }).outcome === "string" &&
        "status" in parsed &&
        typeof (parsed as { status: unknown }).status === "number"
      ) {
        records.push(parsed as WebhookDebugRecord);
      }
    } catch {
      // Drop corrupt lines; file is best-effort diagnostics only.
    }
  }
  return records;
}

function encodeDebugNdjson(records: ReadonlyArray<WebhookDebugRecord>): string {
  if (records.length === 0) return "";
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export class WebhookDebugLog extends Context.Service<
  WebhookDebugLog,
  {
    readonly append: (input: WebhookDebugAppendInput) => Effect.Effect<void>;
  }
>()("t3/jira/JiraWebhookDebugLog/WebhookDebugLog") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const bootNowMs = yield* Clock.currentTimeMillis;

  type SourceState = {
    readonly filePath: string;
    readonly records: Ref.Ref<WebhookDebugRecord[]>;
  };

  const sources = new Map<WebhookSource, SourceState>();
  for (const source of WEBHOOK_DEBUG_SOURCES) {
    const filePath = path.join(config.stateDir, webhookDebugFilename(source));
    const initial = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map((raw) => pruneWebhookDebugRecords(parseDebugNdjson(raw), bootNowMs)),
      Effect.orElseSucceed((): WebhookDebugRecord[] => []),
    );
    const records = yield* Ref.make(initial);
    sources.set(source, { filePath, records });
  }

  const lock = yield* Semaphore.make(1);

  const persist = (filePath: string, records: ReadonlyArray<WebhookDebugRecord>) =>
    writeFileStringAtomically({
      filePath,
      contents: encodeDebugNdjson(records),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to persist webhook debug log", {
          filePath,
          cause,
        }),
      ),
    );

  // Drop anything already past retention on boot (per source file).
  for (const state of sources.values()) {
    const current = yield* Ref.get(state.records);
    if (current.length > 0) {
      yield* persist(state.filePath, current);
    }
  }

  return WebhookDebugLog.of({
    append: Effect.fn("WebhookDebugLog.append")((input) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const state = sources.get(input.source);
            if (state === undefined) {
              yield* Effect.logWarning("Webhook debug log: unknown source", {
                source: input.source,
              });
              return;
            }
            const ts = input.ts ?? DateTime.formatIso(yield* DateTime.now);
            const record: WebhookDebugRecord = { ...input, ts };
            const parsedTs = Date.parse(ts);
            const nowMs = Number.isNaN(parsedTs) ? yield* Clock.currentTimeMillis : parsedTs;
            const next = yield* Ref.updateAndGet(state.records, (existing) =>
              pruneWebhookDebugRecords([...existing, record], nowMs),
            );
            yield* persist(state.filePath, next);
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Webhook debug append failed", {
              source: input.source,
              cause,
            }),
          ),
        ),
    ),
  });
});

export const layer = Layer.effect(WebhookDebugLog, make);
