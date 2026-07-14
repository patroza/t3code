// @effect-diagnostics nodeBuiltinImport:off globalDate:off preferSchemaOverJson:off
// Shared sqlite / id helpers for external-session tooling (import + backfill).
// These deliberately shell out to the `sqlite3` CLI so the tooling can run as a
// plain script against an on-disk state DB without pulling in a native driver.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const SQLITE_MAX_BUFFER = 256 * 1024 * 1024;

export function homePath(value: string): string {
  return value === "~" || value.startsWith("~/")
    ? NodePath.join(NodeOS.homedir(), value.slice(value === "~" ? 1 : 2))
    : value;
}

export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Deterministic RFC-4122-shaped UUID from a namespace + key (stable across runs). */
export function stableUuid(kind: string, key: string): string {
  const bytes = NodeCrypto.createHash("sha256").update(`${kind}:${key}`).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Quote a value as a SQL string literal (or NULL), escaping single quotes. */
export function sql(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function sqliteJson(dbPath: string, query: string): Array<Record<string, unknown>> {
  if (!NodeFS.existsSync(dbPath)) {
    return [];
  }
  const out = NodeChildProcess.execFileSync("sqlite3", ["-json", dbPath, query], {
    encoding: "utf8",
    maxBuffer: SQLITE_MAX_BUFFER,
  }).trim();
  return out.length === 0 ? [] : (JSON.parse(out) as Array<Record<string, unknown>>);
}

export function sqliteExec(dbPath: string, script: string): void {
  NodeChildProcess.execFileSync("sqlite3", [dbPath], {
    input: script,
    maxBuffer: SQLITE_MAX_BUFFER,
  });
}
