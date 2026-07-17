import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ServerHostLoadAverage = Schema.Struct({
  m1: Schema.Number,
  m5: Schema.Number,
  m15: Schema.Number,
});
export type ServerHostLoadAverage = typeof ServerHostLoadAverage.Type;

export const ServerHostResourceSnapshot = Schema.Struct({
  status: Schema.Literals(["supported", "unavailable"]),
  checkedAt: IsoDateTime,
  source: Schema.Literals(["os", "procfs", "unavailable"]),
  hostname: Schema.NullOr(TrimmedNonEmptyString),
  platform: Schema.NullOr(TrimmedNonEmptyString),
  cpuPercent: Schema.NullOr(Schema.Number),
  memoryUsedPercent: Schema.NullOr(Schema.Number),
  memoryUsedBytes: Schema.NullOr(Schema.Number),
  memoryAvailableBytes: Schema.NullOr(Schema.Number),
  memoryTotalBytes: Schema.NullOr(Schema.Number),
  loadAverage: Schema.NullOr(ServerHostLoadAverage),
  logicalCores: Schema.NullOr(Schema.Number),
  message: Schema.NullOr(Schema.String),
});
export type ServerHostResourceSnapshot = typeof ServerHostResourceSnapshot.Type;
