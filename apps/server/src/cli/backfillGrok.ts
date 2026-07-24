import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  formatGrokBackfillResult,
  runGrokBackfill,
} from "../externalSessions/backfillGrokSession.ts";
import { baseDirFlag } from "./config.ts";

const threadIdArgument = Argument.string("thread-id").pipe(
  Argument.withDescription("T3 thread id to backfill grok messages into."),
);
const sessionIdFlag = Flag.string("session-id").pipe(
  Flag.withDescription("Grok ACP session id (defaults to the thread's resume cursor)."),
  Flag.optional,
);
const historyFlag = Flag.string("history").pipe(
  Flag.withDescription("Path to grok chat_history.jsonl (defaults to the session's on-disk file)."),
  Flag.optional,
);
const cwdFlag = Flag.string("cwd").pipe(
  Flag.withDescription("Session working directory (used to locate the grok history file)."),
  Flag.optional,
);
const dbFlag = Flag.string("db").pipe(
  Flag.withDescription(
    "Path to the T3 state.sqlite (defaults to <base-dir>/userdata/state.sqlite).",
  ),
  Flag.optional,
);
const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Print the messages that would be added without writing."),
  Flag.withDefault(false),
);
const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print the result as JSON."),
  Flag.withDefault(false),
);
const rebuildAllFlag = Flag.boolean("rebuild-all").pipe(
  Flag.withDescription(
    "Rebuild the entire transcript from grok's log instead of only the tail (repairs wrong, not just missing, messages).",
  ),
  Flag.withDefault(false),
);
const forceFlag = Flag.boolean("force").pipe(
  Flag.withDescription(
    "Emit the resync event even when no messages are missing (re-syncs clients stuck on a stale cached transcript).",
  ),
  Flag.withDefault(false),
);

export const backfillGrokCommand = Command.make("backfill-grok", {
  threadId: threadIdArgument,
  sessionId: sessionIdFlag,
  history: historyFlag,
  cwd: cwdFlag,
  db: dbFlag,
  baseDir: baseDirFlag,
  dryRun: dryRunFlag,
  rebuildAll: rebuildAllFlag,
  force: forceFlag,
  json: jsonFlag,
}).pipe(
  Command.withDescription(
    "Backfill missing user + grok messages from a grok CLI session into an existing T3 thread.",
  ),
  Command.withHandler((flags) =>
    Effect.sync(() =>
      formatGrokBackfillResult(
        runGrokBackfill({
          threadId: flags.threadId,
          dryRun: flags.dryRun,
          rebuildAll: flags.rebuildAll,
          force: flags.force,
          ...(Option.isSome(flags.sessionId) ? { sessionId: flags.sessionId.value } : {}),
          ...(Option.isSome(flags.history) ? { historyPath: flags.history.value } : {}),
          ...(Option.isSome(flags.cwd) ? { cwd: flags.cwd.value } : {}),
          ...(Option.isSome(flags.db) ? { dbPath: flags.db.value } : {}),
          ...(Option.isSome(flags.baseDir) ? { baseDir: flags.baseDir.value } : {}),
        }),
        { json: flags.json },
      ),
    ).pipe(Effect.flatMap((output) => Console.log(output))),
  ),
);
