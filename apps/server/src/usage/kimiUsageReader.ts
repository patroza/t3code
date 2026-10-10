// @effect-diagnostics nodeBuiltinImport:off - transcript identity derives from its local path.
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { KimiSettings } from "@t3tools/contracts";
import type {
  ProviderUsageReader,
  TranscriptUsageFormat,
} from "@t3tools/provider-core/server/usage";
import { resolveKimiHomePath } from "../provider/Drivers/GrokKimiHome.ts";
import { initialKimiScanState, parseKimiLine, type KimiScanState } from "./usageTranscripts.ts";

export const kimiUsageFormat: TranscriptUsageFormat<KimiScanState> = {
  selectFields: {
    timestamp: true,
    message: { type: true, payload: { token_usage: true, message_id: true } },
  },
  mightCarryUsage: (line) => line.includes('"StatusUpdate"') && line.includes('"token_usage"'),
  parseLine: (line, state) => {
    const record = parseKimiLine(line, state);
    return record === null ? [] : [record];
  },
  parseProjected: (projected, state) => {
    const record = parseKimiLine(JSON.stringify(projected), state);
    return record === null ? [] : [record];
  },
  state: {
    initial: (filePath) => initialKimiScanState(NodePath.basename(NodePath.dirname(filePath))),
    schema: Schema.Struct({ sessionId: Schema.String }),
  },
};

export const kimiUsageReader: ProviderUsageReader<KimiSettings, Path.Path> = {
  kind: "transcripts",
  provider: "kimi",
  format: kimiUsageFormat,
  directories: Effect.fn("kimiUsageReader.directories")(function* () {
    const path = yield* Path.Path;
    const home = yield* resolveKimiHomePath();
    return [{ dir: path.join(home, "sessions"), fileName: "wire.jsonl" }];
  }),
};
