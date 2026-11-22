// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
/**
 * Durable T3 bearer for the Discord bot.
 *
 * Bootstrap (`local-bootstrap-credential`) is exchanged for a 30-day session
 * token. Persist that token so a bot restart does not need the in-memory
 * bootstrap grant still to be valid.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../projectAliases.ts";

export const PERSISTED_BEARER_FILENAME = "t3-bearer.json";

/** Re-bootstrap when less than this remains on the stored session. */
export const PERSISTED_BEARER_MIN_REMAINING_MS = 60 * 60 * 1000;

export const PersistedBearerSession = Schema.Struct({
  accessToken: Schema.String,
  expiresAt: Schema.String,
  httpBaseUrl: Schema.String,
});
export type PersistedBearerSession = typeof PersistedBearerSession.Type;

const decodePersistedBearerSession = Schema.decodeUnknownSync(PersistedBearerSession);

export function persistedBearerFilePath(dataDir: string): string {
  return NodePath.join(expandHomePath(dataDir), PERSISTED_BEARER_FILENAME);
}

export function normalizeHttpBaseUrl(value: string): string {
  try {
    return new URL(value).toString();
  } catch {
    return value;
  }
}

export function persistedBearerExpiresAtIso(nowMs: number, expiresInSeconds: number): string {
  const ttlMs = Math.max(0, expiresInSeconds) * 1000;
  return new Date(nowMs + ttlMs).toISOString();
}

export function parsePersistedBearerSession(raw: unknown): PersistedBearerSession | null {
  try {
    const decoded = decodePersistedBearerSession(raw);
    if (decoded.accessToken.trim() === "" || decoded.httpBaseUrl.trim() === "") return null;
    if (!Number.isFinite(Date.parse(decoded.expiresAt))) return null;
    return decoded;
  } catch {
    return null;
  }
}

export function shouldReusePersistedBearer(input: {
  readonly record: Pick<PersistedBearerSession, "expiresAt" | "httpBaseUrl" | "accessToken">;
  readonly nowMs: number;
  readonly httpBaseUrl: string;
  readonly minRemainingMs?: number;
}): boolean {
  if (input.record.accessToken.trim() === "") return false;
  if (normalizeHttpBaseUrl(input.record.httpBaseUrl) !== normalizeHttpBaseUrl(input.httpBaseUrl)) {
    return false;
  }
  const expiresAtMs = Date.parse(input.record.expiresAt);
  if (!Number.isFinite(expiresAtMs)) return false;
  const minRemaining = input.minRemainingMs ?? PERSISTED_BEARER_MIN_REMAINING_MS;
  return expiresAtMs - input.nowMs >= minRemaining;
}

export function readPersistedBearerSession(dataDir: string): PersistedBearerSession | null {
  try {
    const raw = NodeFS.readFileSync(persistedBearerFilePath(dataDir), "utf8");
    return parsePersistedBearerSession(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writePersistedBearerSession(dataDir: string, record: PersistedBearerSession): void {
  const filePath = persistedBearerFilePath(dataDir);
  const dir = NodePath.dirname(filePath);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tempPath = `${filePath}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tempPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  NodeFS.renameSync(tempPath, filePath);
}

export function clearPersistedBearerSession(dataDir: string): void {
  try {
    NodeFS.unlinkSync(persistedBearerFilePath(dataDir));
  } catch {
    // missing is the desired end state
  }
}
