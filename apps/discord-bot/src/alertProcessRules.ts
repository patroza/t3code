// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parse as parseYaml } from "yaml";

import { expandHomePath } from "./projectAliases.ts";

export interface AlertProcessRule {
  readonly id: string;
  readonly match: string;
  readonly rssMbThreshold?: number;
  readonly cpuPercentThreshold?: number;
  readonly sustainedForMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseCpuPercent(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return value;
}

function parseSizeToMb(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a non-negative number or size string.`);
  }
  const trimmed = value.trim().toLowerCase();
  const match = /^(?<amount>\d+(?:\.\d+)?)\s*(?<unit>b|kb|kib|mb|mib|gb|gib|tb|tib)?$/u.exec(
    trimmed,
  );
  if (!match?.groups) {
    throw new Error(`${field} must be a size like 4096, 4gb, or 512mb.`);
  }
  const amount = Number(match.groups.amount);
  const unit = match.groups.unit ?? "mb";
  const multiplier =
    unit === "b"
      ? 1 / (1024 * 1024)
      : unit === "kb" || unit === "kib"
        ? 1 / 1024
        : unit === "mb" || unit === "mib"
          ? 1
          : unit === "gb" || unit === "gib"
            ? 1024
            : unit === "tb" || unit === "tib"
              ? 1024 * 1024
              : null;
  if (multiplier === null) {
    throw new Error(`${field} has an unsupported unit.`);
  }
  return amount * multiplier;
}

function parseDurationToMs(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value;
  }
  if (typeof value !== "string") {
    throw new Error(`${field} must be a non-negative number of milliseconds or duration string.`);
  }
  const trimmed = value.trim().toLowerCase();
  const match = /^(?<amount>\d+(?:\.\d+)?)\s*(?<unit>ms|s|m|h|d)?$/u.exec(trimmed);
  if (!match?.groups) {
    throw new Error(`${field} must be a duration like 5m, 30s, or 60000.`);
  }
  const amount = Number(match.groups.amount);
  const unit = match.groups.unit ?? "ms";
  const multiplier =
    unit === "ms"
      ? 1
      : unit === "s"
        ? 1_000
        : unit === "m"
          ? 60_000
          : unit === "h"
            ? 60 * 60_000
            : unit === "d"
              ? 24 * 60 * 60_000
              : null;
  if (multiplier === null) {
    throw new Error(`${field} has an unsupported unit.`);
  }
  return amount * multiplier;
}

function parseRule(value: unknown, index: number): AlertProcessRule {
  if (!isRecord(value)) {
    throw new Error(`Process alert rule #${index + 1} must be an object.`);
  }
  const id = normalizeNonEmptyString(value.id);
  if (id === null) {
    throw new Error(`Process alert rule #${index + 1} must include a non-empty id.`);
  }
  const match = normalizeNonEmptyString(value.match);
  if (match === null) {
    throw new Error(`Process alert rule '${id}' must include a non-empty match string.`);
  }
  const rssMbThreshold = parseSizeToMb(
    value.rssMbThreshold ?? value.rssMb ?? value.rss,
    `Process alert rule '${id}' rss`,
  );
  const cpuPercentThreshold = parseCpuPercent(
    value.cpuPercentThreshold ?? value.cpuPercent ?? value.cpu,
    `Process alert rule '${id}' cpu`,
  );
  if (rssMbThreshold === undefined && cpuPercentThreshold === undefined) {
    throw new Error(`Process alert rule '${id}' must set rss and/or cpu thresholds.`);
  }
  const sustainedForMs = parseDurationToMs(
    value.sustainedForMs ?? value.sustainedFor ?? value.duration,
    `Process alert rule '${id}' duration`,
  );
  if (sustainedForMs < 0) {
    throw new Error(`Process alert rule '${id}' duration must be non-negative.`);
  }
  return {
    id,
    match,
    ...(rssMbThreshold === undefined ? {} : { rssMbThreshold }),
    ...(cpuPercentThreshold === undefined ? {} : { cpuPercentThreshold }),
    sustainedForMs,
  };
}

export function parseAlertProcessRulesDocument(document: unknown): ReadonlyArray<AlertProcessRule> {
  const source = Array.isArray(document)
    ? document
    : isRecord(document) && Array.isArray(document.rules)
      ? document.rules
      : null;
  if (source === null) {
    throw new Error("Alert process rules file must be an array or an object with a rules array.");
  }
  return source.map((entry, index) => parseRule(entry, index));
}

export function loadAlertProcessRulesFromFileSync(
  filePath: string | undefined,
): ReadonlyArray<AlertProcessRule> {
  if (filePath === undefined || filePath.trim() === "") return [];
  const resolvedPath = NodePath.resolve(expandHomePath(filePath.trim()));
  if (!NodeFS.existsSync(resolvedPath)) {
    throw new Error(`Alert process rules file not found: ${resolvedPath}`);
  }
  const raw = NodeFS.readFileSync(resolvedPath, "utf8").trim();
  if (raw.length === 0) return [];
  const document = resolvedPath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
  return parseAlertProcessRulesDocument(document);
}
