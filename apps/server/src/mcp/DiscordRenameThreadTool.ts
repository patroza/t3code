import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { dispatchFailure, newCommandId } from "./threadAccess.ts";

const DiscordRenameThreadTool = Tool.make("discord_rename_thread", {
  description:
    "Rename the current T3 thread. When this thread is linked to a Discord thread through the Discord bot, the bot mirrors the new title onto that Discord thread automatically.",
  parameters: Schema.Struct({
    title: Schema.String.annotate({
      description: "New concise title for the current linked thread.",
    }),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    title: Schema.String,
    discordMirrorRequested: Schema.Literal(true),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService,
    SecureRandom.SecureRandom,
  ],
})
  .annotate(Tool.Title, "Rename linked Discord thread")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenFromOutsideClients);

export const DiscordRenameThreadToolkit = Toolkit.make(DiscordRenameThreadTool);

const normalizeDiscordThreadTitle = (raw: string) => raw.trim().replace(/\s+/g, " ");

const renameCallingThread = Effect.fn("DiscordRenameThreadTool.rename")(function* (input: {
  readonly title: string;
}) {
  const title = normalizeDiscordThreadTitle(input.title);
  if (title.length === 0) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Title cannot be empty.",
    });
  }
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const threadId = (yield* McpInvocationContext.requireThreadScope(scope, "Renaming")).thread
    .threadId;
  const threads = yield* ThreadManagementService;
  yield* threads
    .dispatch({ type: "thread.metadata.update", commandId: yield* newCommandId(), threadId, title })
    .pipe(Effect.mapError(dispatchFailure));
  return { threadId, title, discordMirrorRequested: true as const };
});

// actsAsCaller refuses read-only clients and callers whose run already ended.
export const layer = McpToolAccess.toLayer(DiscordRenameThreadToolkit, {
  discord_rename_thread: McpToolAccess.actsAsCaller(renameCallingThread),
});
