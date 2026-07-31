/**
 * Short-lived connection diagnostics for post-hoc debugging of reconnect storms.
 *
 * Events are stored as NDJSON-ish JSON records with a hard 12-hour retention window.
 * Default sink uses localStorage when available, otherwise an in-memory ring.
 * Always also emits Effect.logWarning so traces/console still see the event.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const CONNECTION_DIAGNOSTICS_RETENTION_MS = 12 * 60 * 60 * 1000;
export const CONNECTION_DIAGNOSTICS_STORAGE_KEY = "t3code:connection-diagnostics:v1";
const MAX_EVENTS = 400;

export const ConnectionDiagnosticKind = Schema.Literals([
  "disconnect",
  "connect_failed",
  "backoff",
  "blocked",
  "probe_failed",
]);
export type ConnectionDiagnosticKind = typeof ConnectionDiagnosticKind.Type;

export class ConnectionDiagnosticEvent extends Schema.Class<ConnectionDiagnosticEvent>(
  "ConnectionDiagnosticEvent",
)({
  at: Schema.String,
  environmentId: Schema.String,
  label: Schema.String,
  kind: ConnectionDiagnosticKind,
  reason: Schema.String,
  detail: Schema.String,
  traceId: Schema.optionalKey(Schema.String),
  closeCode: Schema.optionalKey(Schema.Number),
  closeReason: Schema.optionalKey(Schema.String),
  /** Hostname only — never full socket URLs (tickets). */
  socketHost: Schema.optionalKey(Schema.String),
  attempt: Schema.optionalKey(Schema.Number),
}) {}

export type ConnectionDiagnosticEventInput = {
  readonly environmentId: string;
  readonly label: string;
  readonly kind: ConnectionDiagnosticKind;
  readonly reason: string;
  readonly detail: string;
  readonly traceId?: string | undefined;
  readonly closeCode?: number | undefined;
  readonly closeReason?: string | undefined;
  readonly socketHost?: string | undefined;
  readonly attempt?: number | undefined;
  readonly at?: string | undefined;
};

export class ConnectionDiagnosticsLog extends Context.Service<
  ConnectionDiagnosticsLog,
  {
    readonly record: (event: ConnectionDiagnosticEventInput) => Effect.Effect<void>;
    readonly list: Effect.Effect<ReadonlyArray<ConnectionDiagnosticEvent>>;
  }
>()("@t3tools/client-runtime/connection/diagnosticsLog/ConnectionDiagnosticsLog") {}

function pruneEvents(
  events: ReadonlyArray<ConnectionDiagnosticEvent>,
  nowMs: number,
): ConnectionDiagnosticEvent[] {
  const cutoff = nowMs - CONNECTION_DIAGNOSTICS_RETENTION_MS;
  return events
    .filter((event) => {
      const atMs = Date.parse(event.at);
      return Number.isFinite(atMs) && atMs >= cutoff;
    })
    .slice(-MAX_EVENTS);
}

function readStorage(): ConnectionDiagnosticEvent[] {
  if (typeof globalThis.localStorage === "undefined") return [];
  try {
    const raw = globalThis.localStorage.getItem(CONNECTION_DIAGNOSTICS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      try {
        return [Schema.decodeSync(ConnectionDiagnosticEvent)(item)];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function writeStorage(events: ReadonlyArray<ConnectionDiagnosticEvent>): void {
  if (typeof globalThis.localStorage === "undefined") return;
  try {
    globalThis.localStorage.setItem(CONNECTION_DIAGNOSTICS_STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Quota / private mode — drop silently; Effect.log still recorded.
  }
}

let memoryEvents: ConnectionDiagnosticEvent[] = [];

export const make = Effect.sync(() => {
  const record = (input: ConnectionDiagnosticEventInput): Effect.Effect<void> =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const event = new ConnectionDiagnosticEvent({
        at: input.at ?? DateTime.formatIso(yield* DateTime.now),
        environmentId: input.environmentId,
        label: input.label,
        kind: input.kind,
        reason: input.reason,
        detail: input.detail,
        ...(input.traceId !== undefined ? { traceId: input.traceId } : {}),
        ...(input.closeCode !== undefined ? { closeCode: input.closeCode } : {}),
        ...(input.closeReason !== undefined ? { closeReason: input.closeReason } : {}),
        ...(input.socketHost !== undefined ? { socketHost: input.socketHost } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
      });

      yield* Effect.logWarning("connection diagnostics", {
        kind: event.kind,
        environmentId: event.environmentId,
        label: event.label,
        reason: event.reason,
        detail: event.detail,
        ...(event.traceId !== undefined ? { traceId: event.traceId } : {}),
        ...(event.closeCode !== undefined ? { closeCode: event.closeCode } : {}),
        ...(event.socketHost !== undefined ? { socketHost: event.socketHost } : {}),
        ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
      });

      const previous =
        typeof globalThis.localStorage !== "undefined" ? readStorage() : memoryEvents;
      const next = pruneEvents([...previous, event], nowMs);
      if (typeof globalThis.localStorage !== "undefined") {
        writeStorage(next);
      } else {
        memoryEvents = next;
      }
    }).pipe(Effect.asVoid, Effect.ignore);

  const list = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const previous = typeof globalThis.localStorage !== "undefined" ? readStorage() : memoryEvents;
    const next = pruneEvents(previous, nowMs);
    if (typeof globalThis.localStorage !== "undefined") {
      writeStorage(next);
    } else {
      memoryEvents = next;
    }
    return next;
  });

  return ConnectionDiagnosticsLog.of({ record, list });
});

export const layer = Layer.effect(ConnectionDiagnosticsLog, make);

/** Test helper: clear in-memory / localStorage diagnostics. */
export function clearConnectionDiagnosticsForTests(): void {
  memoryEvents = [];
  if (typeof globalThis.localStorage !== "undefined") {
    try {
      globalThis.localStorage.removeItem(CONNECTION_DIAGNOSTICS_STORAGE_KEY);
    } catch {
      // ignore
    }
  }
}
