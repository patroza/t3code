import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Argument, Command, Flag } from "effect/unstable/cli";

import {
  formatImportSessionsResults,
  runImportSessions,
} from "../externalSessions/importSessions.ts";
import { baseDirFlag } from "./config.ts";

const providerFlag = Flag.choice("provider", ["all", "codex", "claude", "opencode"]).pipe(
  Flag.withDescription("Provider sessions to import."),
  Flag.withDefault("all"),
);
const cwdFlag = Flag.string("cwd").pipe(
  Flag.withDescription("Only import sessions for this working directory."),
  Flag.optional,
);
const limitFlag = Flag.integer("limit").pipe(
  Flag.withDescription("Maximum sessions per provider."),
  Flag.withDefault(50),
);
const dryRunFlag = Flag.boolean("dry-run").pipe(
  Flag.withDescription("Print sessions without writing T3 state."),
  Flag.withDefault(false),
);
const jsonFlag = Flag.boolean("json").pipe(
  Flag.withDescription("Print imported sessions as JSON."),
  Flag.withDefault(false),
);
const opencodeModelFlag = Flag.string("opencode-model").pipe(
  Flag.withDescription("Model selection for imported OpenCode sessions."),
  Flag.withDefault("zai-coding-plan/glm-5.2"),
);
const sessionIdArgument = Argument.string("session-id").pipe(
  Argument.withDescription("Optional provider session id to import."),
  Argument.optional,
);

export const importSessionsCommand = Command.make("import-sessions", {
  provider: providerFlag,
  cwd: cwdFlag,
  limit: limitFlag,
  dryRun: dryRunFlag,
  json: jsonFlag,
  baseDir: baseDirFlag,
  opencodeModel: opencodeModelFlag,
  sessionId: sessionIdArgument,
}).pipe(
  Command.withDescription("Import existing Codex, Claude, or OpenCode sessions into T3."),
  Command.withHandler((flags) =>
    Effect.sync(() =>
      formatImportSessionsResults(
        runImportSessions({
          provider: flags.provider,
          limit: flags.limit,
          dryRun: flags.dryRun,
          opencodeModel: flags.opencodeModel,
          ...(Option.isSome(flags.cwd) ? { cwd: flags.cwd.value } : {}),
          ...(Option.isSome(flags.baseDir) ? { baseDir: flags.baseDir.value } : {}),
          ...(Option.isSome(flags.sessionId) ? { sessionId: flags.sessionId.value } : {}),
        }),
        { json: flags.json },
      ),
    ).pipe(Effect.flatMap((output) => Console.log(output))),
  ),
);
