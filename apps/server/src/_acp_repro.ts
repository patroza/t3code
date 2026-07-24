import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CursorSettings } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { discoverCursorModelsViaAcp } from "./provider/Layers/CursorProvider.ts";

const settings = Schema.decodeSync(CursorSettings)({ binaryPath: "agent" });

const program = Effect.gen(function* () {
  const exit = yield* Effect.exit(discoverCursorModelsViaAcp(settings, process.env));
  if (exit._tag === "Failure") {
    yield* Effect.logError("Cursor ACP discovery failed", {
      cause: Cause.pretty(exit.cause),
    });
  } else {
    yield* Effect.logInfo("Cursor ACP discovery succeeded", {
      modelCount: exit.value.length,
    });
  }
}).pipe(Effect.provide(NodeServices.layer));

NodeRuntime.runMain(program);
