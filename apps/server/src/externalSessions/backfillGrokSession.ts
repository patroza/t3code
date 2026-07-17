// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
// Backfill missing user + assistant messages from a grok CLI session into an
// existing T3 thread.
//
// When a grok ACP session gets wedged (see effect-acp Interrupt-frame leak), or
// the conversation continues outside T3, T3 stops ingesting grok's
// `session/update` notifications while grok keeps persisting them to
// `~/.grok/sessions/.../updates.jsonl`. The T3 transcript is then missing the
// tail. This tool reconstructs that tail: it anchors on T3's last assistant
// message (the last known-good point), walks grok's update log after it, and
// emits a single `thread.messages-resynced` event carrying that anchor plus the
// authoritative tail. Messages the thread already has keep their identity and
// timestamp; new ones carry grok's own emit time.
//
// It deliberately emits an EVENT rather than writing the projection directly:
// clients resume from `afterSequence` and never re-read the projection, so a
// direct write would be invisible to them forever. It is idempotent — re-running
// an identical backfill yields the same event id and changes nothing.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { homePath, sql, sqliteExec, sqliteJson, stableUuid } from "./sqlite.ts";

const GROK_PROVIDER = "grok";

export interface GrokDisplayMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  /**
   * Byte offset of the line in updates.jsonl — the stable identity/order key.
   * A byte offset (not a line number) so it stays identical whether the file was
   * read whole or from a tail window; a line number would depend on where the
   * read began and would mint different ids for the same message.
   */
  readonly sourceOffset: number;
  /** When grok emitted it (ms). */
  readonly emittedAtMs: number;
}

export interface ExistingThreadMessage {
  readonly messageId: string;
  readonly role: string;
  readonly text: string;
  readonly turnId: string | null;
  readonly attachmentsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface GrokBackfillMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly sourceOffset: number;
  readonly messageId: string;
  readonly turnId: string | null;
  readonly attachmentsJson: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** False for messages the thread already had (kept for position/identity). */
  readonly isNew: boolean;
}

export interface GrokBackfillPlan {
  /** Last known-good message: the resync rewinds to just after this one. */
  readonly anchorMessageId: string | null;
  readonly anchorLineIndex: number | null;
  readonly skippedExisting: number;
  /** The complete authoritative transcript after the anchor, in order. */
  readonly tail: ReadonlyArray<GrokBackfillMessage>;
  readonly newMessages: ReadonlyArray<GrokBackfillMessage>;
  readonly error?: string;
}

export type GrokBackfillStatus = "backfilled" | "up-to-date" | "dry-run" | "error";

export interface GrokBackfillResult {
  readonly threadId: string;
  readonly sessionId: string | null;
  readonly historyPath: string | null;
  readonly status: GrokBackfillStatus;
  readonly addedCount: number;
  readonly skippedExisting: number;
  readonly anchorLineIndex: number | null;
  readonly newMessages: ReadonlyArray<GrokBackfillMessage>;
  readonly error?: string;
}

export interface RunGrokBackfillOptions {
  readonly threadId: string;
  readonly sessionId?: string;
  readonly historyPath?: string;
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly dbPath?: string;
  readonly dryRun: boolean;
  /**
   * Replace the whole transcript from grok rather than only the tail after the
   * anchor. Repairs a thread whose existing messages are wrong, not just
   * missing. Destructive: grok's log becomes the sole source of truth.
   */
  readonly rebuildAll?: boolean;
  /**
   * Emit the resync event even when the projection already holds every message.
   * Needed when a transcript was repaired out-of-band without an event: the rows
   * are right but connected clients never heard about it, so they are stuck on a
   * stale cached snapshot until a resync event reaches them.
   */
  readonly force?: boolean;
}

const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

/**
 * One `updates.jsonl` record -> a transcript message, if it is one.
 *
 * Only `user_message_chunk` and `agent_message_chunk` are transcript content;
 * thoughts, tool calls, plans and hook/compaction bookkeeping are skipped.
 */
function parseUpdateLine(line: string, sourceOffset: number): GrokDisplayMessage | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const params = record.params;
  if (typeof params !== "object" || params === null) {
    return undefined;
  }
  const update = (params as Record<string, unknown>).update;
  if (typeof update !== "object" || update === null) {
    return undefined;
  }
  const kind = (update as Record<string, unknown>).sessionUpdate;
  const role =
    kind === "user_message_chunk" ? "user" : kind === "agent_message_chunk" ? "assistant" : null;
  if (role === null) {
    return undefined;
  }
  const content = (update as Record<string, unknown>).content;
  const text =
    typeof content === "object" && content !== null
      ? (content as Record<string, unknown>).text
      : undefined;
  if (typeof text !== "string" || text.trim().length === 0) {
    return undefined;
  }
  // grok stamps unix seconds.
  const timestamp = record.timestamp;
  const emittedAtMs = typeof timestamp === "number" ? timestamp * 1000 : Number.NaN;
  return { role, text, sourceOffset, emittedAtMs };
}

function collectFromChunk(
  chunk: string,
  chunkStartOffset: number,
): ReadonlyArray<GrokDisplayMessage> {
  const out: Array<GrokDisplayMessage> = [];
  let cursor = 0;
  for (const line of chunk.split("\n")) {
    const message = parseUpdateLine(line, chunkStartOffset + cursor);
    if (message) {
      out.push(message);
    }
    cursor += Buffer.byteLength(line, "utf8") + 1;
  }
  return out;
}

/**
 * Read grok's `updates.jsonl` — the session/update notification log, the same
 * stream T3 ingests live over ACP, and NOT `chat_history.jsonl`. chat_history is
 * grok's LLM context: grok compacts it, rewriting and discarding old turns, so
 * it is not a transcript and cannot be relied on to still hold what T3 missed.
 * `updates.jsonl` is append-only, survives compaction, and carries real emit
 * timestamps.
 *
 * Reads the whole log: blocking and unbounded — these files reach hundreds of MB,
 * so this is for offline tooling (the CLI) only. Anything on a request path must
 * use `readGrokDisplayMessagesTail`.
 */
export function readGrokDisplayMessages(updatesPath: string): ReadonlyArray<GrokDisplayMessage> {
  if (!NodeFS.existsSync(updatesPath)) {
    return [];
  }
  return collectFromChunk(NodeFS.readFileSync(updatesPath, "utf8"), 0);
}

/**
 * Read at most the last `maxBytes` of the log, without loading the rest.
 *
 * These logs are dominated by tool-call traffic and grow without bound (150MB
 * observed for ~140 messages), so reading one whole file cost ~570ms of blocked
 * event loop per call. The transcript tail we actually need sits at the end, so
 * read backwards from there.
 *
 * A window that starts mid-line would yield a truncated record, so the first
 * partial line is dropped — meaning a caller must tolerate the window missing
 * older messages (widen, or give up) rather than treat this as the full log.
 */
export async function readGrokDisplayMessagesTail(
  updatesPath: string,
  maxBytes: number,
): Promise<ReadonlyArray<GrokDisplayMessage>> {
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(updatesPath, "r");
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) {
      return [];
    }
    const buffer = Buffer.allocUnsafe(length);
    await handle.read(buffer, 0, length, start);
    const chunk = buffer.toString("utf8");
    if (start === 0) {
      return collectFromChunk(chunk, 0);
    }
    // Drop the (probably partial) first line and resume at the next boundary.
    const firstBreak = chunk.indexOf("\n");
    if (firstBreak === -1) {
      return [];
    }
    const rest = chunk.slice(firstBreak + 1);
    return collectFromChunk(
      rest,
      start + Buffer.byteLength(chunk.slice(0, firstBreak + 1), "utf8"),
    );
  } finally {
    await handle.close();
  }
}

/**
 * Compute the append plan. Pure: given grok's displayable messages and the
 * thread's existing messages, decide which grok messages are new and what
 * timestamp each should carry. Anchors on T3's last assistant message; refuses
 * to guess if that anchor cannot be located in grok's history.
 */
export function planGrokBackfill(input: {
  readonly grokMessages: ReadonlyArray<GrokDisplayMessage>;
  readonly existingMessages: ReadonlyArray<ExistingThreadMessage>;
  readonly sessionId: string;
  /**
   * Rebuild the whole transcript from grok instead of only the tail after the
   * anchor. For repairing a thread whose existing messages are themselves wrong
   * (not merely missing) — grok's log is then the sole source of truth, so only
   * do this when it demonstrably covers the entire session.
   */
  readonly rebuildAll?: boolean;
}): GrokBackfillPlan {
  const { grokMessages, existingMessages, sessionId } = input;
  const rebuildAll = input.rebuildAll === true;

  // Everything before the anchor is trusted as-is; a full rebuild trusts nothing
  // and replays from the start.
  let anchorIndex = -1;
  let anchorMessageId: string | null = null;
  let cursorMs = 0;

  if (!rebuildAll) {
    const assistants = existingMessages.filter((message) => message.role === "assistant");
    if (assistants.length === 0) {
      return {
        anchorMessageId: null,
        anchorLineIndex: null,
        skippedExisting: 0,
        tail: [],
        newMessages: [],
        error: "T3 thread has no assistant message to anchor on.",
      };
    }
    const lastAssistant = assistants[assistants.length - 1]!;
    const lastAssistantNorm = normalize(lastAssistant.text);

    // Anchor on the LAST grok assistant message that matches T3's last assistant
    // (prefix either way tolerates one side having truncated the text).
    for (let i = grokMessages.length - 1; i >= 0; i -= 1) {
      const candidate = grokMessages[i]!;
      if (candidate.role !== "assistant") {
        continue;
      }
      const candidateNorm = normalize(candidate.text);
      if (
        candidateNorm === lastAssistantNorm ||
        candidateNorm.startsWith(lastAssistantNorm) ||
        lastAssistantNorm.startsWith(candidateNorm)
      ) {
        anchorIndex = i;
        break;
      }
    }
    if (anchorIndex === -1) {
      return {
        anchorMessageId: null,
        anchorLineIndex: null,
        skippedExisting: 0,
        tail: [],
        newMessages: [],
        error:
          "Could not locate T3's last assistant message in grok history; refusing to guess the anchor.",
      };
    }
    anchorMessageId = lastAssistant.messageId;
    cursorMs = Date.parse(lastAssistant.createdAt);
  }

  const existingByKey = new Map<string, ExistingThreadMessage>();
  for (const message of existingMessages) {
    existingByKey.set(`${message.role}|${normalize(message.text)}`, message);
  }

  // Build the complete authoritative transcript after the anchor. Messages the
  // thread already has keep their identity and timestamp (they are correct, just
  // stranded); genuinely new ones get a stable id and a synthesized timestamp
  // that slots them into the real chronological gap.
  const tail: Array<GrokBackfillMessage> = [];
  const newMessages: Array<GrokBackfillMessage> = [];
  let skippedExisting = 0;

  for (const message of grokMessages.slice(anchorIndex + 1)) {
    const key = `${message.role}|${normalize(message.text)}`;
    const existing = existingByKey.get(key);
    if (existing !== undefined) {
      const parsed = Date.parse(existing.createdAt);
      if (Number.isFinite(parsed)) {
        cursorMs = Math.max(cursorMs, parsed);
      }
      skippedExisting += 1;
      tail.push({
        role: message.role,
        text: existing.text,
        sourceOffset: message.sourceOffset,
        messageId: existing.messageId,
        turnId: existing.turnId,
        attachmentsJson: existing.attachmentsJson,
        createdAt: existing.createdAt,
        updatedAt: existing.updatedAt,
        isNew: false,
      });
      continue;
    }
    // Prefer grok's own emit time, but never let it break ordering against the
    // messages we are splicing between (clocks and ingest lag can disagree).
    cursorMs = Number.isFinite(message.emittedAtMs)
      ? Math.max(cursorMs + 1, message.emittedAtMs)
      : cursorMs + 1;
    const createdAt = new Date(cursorMs).toISOString();
    const entry: GrokBackfillMessage = {
      role: message.role,
      text: message.text,
      sourceOffset: message.sourceOffset,
      messageId: stableUuid("t3-grok-backfill-message", `${sessionId}:${message.sourceOffset}`),
      turnId: null,
      attachmentsJson: "[]",
      createdAt,
      updatedAt: createdAt,
      isNew: true,
    };
    tail.push(entry);
    newMessages.push(entry);
  }

  return {
    anchorMessageId,
    anchorLineIndex: anchorIndex === -1 ? null : grokMessages[anchorIndex]!.sourceOffset,
    skippedExisting,
    tail,
    newMessages,
  };
}

function readExistingThreadMessages(
  dbPath: string,
  threadId: string,
): ReadonlyArray<ExistingThreadMessage> {
  return sqliteJson(
    dbPath,
    `SELECT message_id, role, text, turn_id, attachments_json, created_at, updated_at
     FROM projection_thread_messages
     WHERE thread_id = ${sql(threadId)} ORDER BY created_at ASC, message_id ASC`,
  ).map((row) => ({
    messageId: String(row.message_id),
    role: String(row.role),
    text: String(row.text ?? ""),
    turnId: row.turn_id == null ? null : String(row.turn_id),
    attachmentsJson: row.attachments_json == null ? "[]" : String(row.attachments_json),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at ?? row.created_at),
  }));
}

function resolveGrokSessionMeta(
  dbPath: string,
  threadId: string,
): { readonly sessionId: string | null; readonly cwd: string | null } {
  const row = sqliteJson(
    dbPath,
    `SELECT json_extract(resume_cursor_json, '$.sessionId') AS session_id,
            json_extract(runtime_payload_json, '$.cwd') AS cwd
     FROM provider_session_runtime
     WHERE thread_id = ${sql(threadId)} AND provider_name = ${sql(GROK_PROVIDER)}
     LIMIT 1`,
  )[0];
  return {
    sessionId: row && row.session_id != null ? String(row.session_id) : null,
    cwd: row && row.cwd != null ? String(row.cwd) : null,
  };
}

/**
 * Grok persists sessions under ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/.
 *
 * We read `updates.jsonl` (the append-only session/update log), not
 * `chat_history.jsonl` — see readGrokDisplayMessages for why.
 */
export function resolveGrokChatHistoryPath(input: {
  readonly cwd: string;
  readonly sessionId: string;
}): string {
  return NodePath.join(
    NodeOS.homedir(),
    ".grok",
    "sessions",
    encodeURIComponent(input.cwd),
    input.sessionId,
    "updates.jsonl",
  );
}

/**
 * Append the resync as a single domain event.
 *
 * The event — not a direct projection write — is what makes the rebuild real:
 * the projector materializes it into `projection_thread_messages`, and clients
 * (which resume from `afterSequence` and never re-read the projection on their
 * own) receive it through the ordinary catch-up replay and splice their cached
 * transcript. Writing the projection directly would be invisible to them.
 */
function appendResyncEvent(
  dbPath: string,
  threadId: string,
  sessionId: string,
  plan: GrokBackfillPlan,
): void {
  const payload = {
    threadId,
    afterMessageId: plan.anchorMessageId,
    messages: plan.tail.map((message) => ({
      id: message.messageId,
      role: message.role,
      text: message.text,
      attachments: JSON.parse(message.attachmentsJson) as ReadonlyArray<unknown>,
      turnId: message.turnId,
      streaming: false,
      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    })),
    reason: `grok-backfill:${sessionId}`,
  };
  const versionRow = sqliteJson(
    dbPath,
    `SELECT COALESCE(MAX(stream_version), -1) AS max_version FROM orchestration_events
     WHERE aggregate_kind = 'thread' AND stream_id = ${sql(threadId)}`,
  )[0];
  const nextVersion = Number(versionRow?.max_version ?? -1) + 1;
  const occurredAt = plan.tail[plan.tail.length - 1]?.updatedAt ?? new Date().toISOString();
  // Keyed by the resulting tail, so re-running an identical backfill cannot
  // append a second event.
  const eventId = stableUuid(
    "t3-grok-backfill-event",
    `${threadId}:${plan.anchorMessageId ?? "*"}:${plan.tail.map((m) => m.messageId).join(",")}`,
  );
  sqliteExec(
    dbPath,
    `BEGIN;
INSERT OR IGNORE INTO orchestration_events (event_id,aggregate_kind,stream_id,stream_version,event_type,occurred_at,command_id,causation_event_id,correlation_id,actor_kind,payload_json,metadata_json)
VALUES (${sql(eventId)},'thread',${sql(threadId)},${nextVersion},'thread.messages-resynced',${sql(occurredAt)},NULL,NULL,NULL,'system',${sql(JSON.stringify(payload))},'{}');
COMMIT;`,
  );
}

export function runGrokBackfill(options: RunGrokBackfillOptions): GrokBackfillResult {
  const baseDir = homePath(options.baseDir ?? process.env.T3CODE_HOME ?? "~/.t3");
  const dbPath = options.dbPath ?? NodePath.join(baseDir, "userdata", "state.sqlite");

  const meta = resolveGrokSessionMeta(dbPath, options.threadId);
  const sessionId = options.sessionId ?? meta.sessionId;
  const cwd = options.cwd ?? meta.cwd;

  const base = {
    threadId: options.threadId,
    sessionId,
    historyPath: null,
    addedCount: 0,
    skippedExisting: 0,
    anchorLineIndex: null,
    newMessages: [] as ReadonlyArray<GrokBackfillMessage>,
  };

  if (!sessionId) {
    return {
      ...base,
      status: "error",
      error: `No grok session id found for thread ${options.threadId} (pass --session-id).`,
    };
  }
  const historyPath =
    options.historyPath ?? (cwd ? resolveGrokChatHistoryPath({ cwd, sessionId }) : null);
  if (!historyPath) {
    return {
      ...base,
      sessionId,
      status: "error",
      error: `No grok cwd found for thread ${options.threadId} (pass --history or --cwd).`,
    };
  }
  if (!NodeFS.existsSync(historyPath)) {
    return {
      ...base,
      sessionId,
      historyPath,
      status: "error",
      error: `Grok history file not found: ${historyPath}`,
    };
  }

  const grokMessages = readGrokDisplayMessages(historyPath);
  const existingMessages = readExistingThreadMessages(dbPath, options.threadId);
  const plan = planGrokBackfill({
    grokMessages,
    existingMessages,
    sessionId,
    ...(options.rebuildAll === true ? { rebuildAll: true } : {}),
  });

  if (plan.error) {
    return {
      ...base,
      sessionId,
      historyPath,
      status: "error",
      skippedExisting: plan.skippedExisting,
      anchorLineIndex: plan.anchorLineIndex,
      error: plan.error,
    };
  }

  const resultBase = {
    threadId: options.threadId,
    sessionId,
    historyPath,
    addedCount: plan.newMessages.length,
    skippedExisting: plan.skippedExisting,
    anchorLineIndex: plan.anchorLineIndex,
    newMessages: plan.newMessages,
  };

  if (options.dryRun) {
    return { ...resultBase, status: "dry-run" };
  }
  if (plan.newMessages.length === 0 && options.force !== true && options.rebuildAll !== true) {
    return { ...resultBase, status: "up-to-date" };
  }
  appendResyncEvent(dbPath, options.threadId, sessionId, plan);
  return { ...resultBase, status: "backfilled" };
}

export function formatGrokBackfillResult(
  result: GrokBackfillResult,
  options: { readonly json: boolean },
): string {
  if (options.json) {
    return JSON.stringify(result, null, 2);
  }
  if (result.status === "error") {
    return `error\t${result.threadId}\t${result.error ?? "unknown error"}`;
  }
  const header =
    `${result.status}\tthread=${result.threadId}\tsession=${result.sessionId ?? "?"}\t` +
    `added=${result.addedCount}\tskipped=${result.skippedExisting}\tanchor-line=${result.anchorLineIndex ?? "?"}`;
  const detail = result.newMessages
    .map(
      (message) =>
        `  + [${message.role}] @${message.sourceOffset} ${message.createdAt}  ` +
        JSON.stringify(normalize(message.text).slice(0, 80)),
    )
    .join("\n");
  return detail.length > 0 ? `${header}\n${detail}` : header;
}
