import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

/** Retain webhook debug rows for at most one day. */
export const JIRA_WEBHOOK_DEBUG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Safety cap so a flood cannot grow the file without bound. */
export const JIRA_WEBHOOK_DEBUG_MAX_RECORDS = 5_000;
/** Cap stored request body previews (invalid/ignored diagnosis). */
export const JIRA_WEBHOOK_DEBUG_BODY_PREVIEW_CHARS = 4_000;

export const JIRA_WEBHOOK_DEBUG_FILENAME = "jira-webhook-debug.ndjson";

export type JiraWebhookDebugOutcome =
  | "disabled_404"
  | "too_large_413"
  | "unauthorized_401"
  | "invalid_400"
  | "ignored_202"
  | "project_denied_202"
  | "accepted_202";

export interface JiraWebhookDebugRecord {
  readonly ts: string;
  readonly outcome: JiraWebhookDebugOutcome;
  readonly status: number;
  readonly reason?: string;
  readonly bodyBytes: number;
  readonly bodyPreview?: string;
  readonly deliveryId?: string;
  readonly issueKey?: string;
  readonly projectKey?: string;
  readonly webhookEvent?: string;
  readonly commentId?: string;
  readonly prompt?: string;
  readonly commentText?: string;
  readonly actorDisplayName?: string | null;
  readonly actorAccountId?: string | null;
  readonly mention?: string;
}

export type JiraWebhookDebugAppendInput = Omit<JiraWebhookDebugRecord, "ts"> & {
  readonly ts?: string;
};

export function previewWebhookBody(
  body: string,
  maxChars: number = JIRA_WEBHOOK_DEBUG_BODY_PREVIEW_CHARS,
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
 * Classify why a raw Automation/webhook body failed decode.
 * Distinguishes broken JSON (common when `{{comment.body}}` injects newlines)
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

export function pruneJiraWebhookDebugRecords(
  records: ReadonlyArray<JiraWebhookDebugRecord>,
  nowMs: number,
  maxAgeMs: number = JIRA_WEBHOOK_DEBUG_MAX_AGE_MS,
  maxRecords: number = JIRA_WEBHOOK_DEBUG_MAX_RECORDS,
): JiraWebhookDebugRecord[] {
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

function parseDebugNdjson(raw: string): JiraWebhookDebugRecord[] {
  const records: JiraWebhookDebugRecord[] = [];
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
        records.push(parsed as JiraWebhookDebugRecord);
      }
    } catch {
      // Drop corrupt lines; file is best-effort diagnostics only.
    }
  }
  return records;
}

function encodeDebugNdjson(records: ReadonlyArray<JiraWebhookDebugRecord>): string {
  if (records.length === 0) return "";
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

export class JiraWebhookDebugLog extends Context.Service<
  JiraWebhookDebugLog,
  {
    readonly append: (input: JiraWebhookDebugAppendInput) => Effect.Effect<void>;
  }
>()("t3/jira/JiraWebhookDebugLog") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, JIRA_WEBHOOK_DEBUG_FILENAME);

  const bootNowMs = yield* Clock.currentTimeMillis;
  const initial = yield* fileSystem.readFileString(filePath).pipe(
    Effect.map((raw) => pruneJiraWebhookDebugRecords(parseDebugNdjson(raw), bootNowMs)),
    Effect.orElseSucceed((): JiraWebhookDebugRecord[] => []),
  );
  const state = yield* Ref.make(initial);
  const lock = yield* Semaphore.make(1);

  const persist = (records: ReadonlyArray<JiraWebhookDebugRecord>) =>
    writeFileStringAtomically({
      filePath,
      contents: encodeDebugNdjson(records),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.catch((cause) =>
        Effect.logWarning("Failed to persist Jira webhook debug log", {
          filePath,
          cause,
        }),
      ),
    );

  // Drop anything already past retention on boot.
  if (initial.length > 0) {
    yield* persist(initial);
  }

  return JiraWebhookDebugLog.of({
    append: (input) =>
      lock
        .withPermit(
          Effect.gen(function* () {
            const ts = input.ts ?? DateTime.formatIso(yield* DateTime.now);
            const record: JiraWebhookDebugRecord = { ...input, ts };
            const parsedTs = Date.parse(ts);
            const nowMs = Number.isNaN(parsedTs) ? yield* Clock.currentTimeMillis : parsedTs;
            const next = yield* Ref.updateAndGet(state, (records) =>
              pruneJiraWebhookDebugRecords([...records, record], nowMs),
            );
            yield* persist(next);
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Jira webhook debug append failed", { cause }),
          ),
        ),
  });
});

export const layer = Layer.effect(JiraWebhookDebugLog, make);
