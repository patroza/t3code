import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ServerCommand,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as DiscordRenameThreadTool from "./DiscordRenameThreadTool.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";

const threadId = ThreadId.make("discord-rename-thread");

const rename = (input: {
  readonly title: string;
  readonly access?: "read-only";
  readonly activeRunId?: RunId | null;
}) =>
  Effect.gen(function* () {
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("discord-rename-environment"),
      requestNamespace: "discord-rename-provider-session",
      thread: {
        threadId,
        providerSessionId: "discord-rename-provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client:
        input.access === undefined
          ? undefined
          : { sessionId: "discord-rename-client", label: "Client", access: input.access },
      capabilities: new Set(),
      issuedAt: 0,
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(
            McpToolAccessTestkit.liveThreadShell(id, {
              activeRunId:
                input.activeRunId === undefined ? RunId.make("run:discord") : input.activeRunId,
            }),
          ),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command);
            return { sequence: 1, storedEvents: [] };
          }),
      }),
      NodeCrypto.layer,
    );
    const toolkit = yield* DiscordRenameThreadTool.DiscordRenameThreadToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(DiscordRenameThreadTool.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    const results = yield* toolkit
      .handle("discord_rename_thread", { title: input.title })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return { result: results.at(-1)?.result, dispatched };
  });

it.effect("renames the calling thread with a normalized title", () =>
  Effect.gen(function* () {
    const { result, dispatched } = yield* rename({ title: "  Fix   the\nlogin bug " });
    expect(result).toEqual({ threadId, title: "Fix the login bug", discordMirrorRequested: true });
    expect(dispatched).toMatchObject([
      { type: "thread.metadata.update", threadId, title: "Fix the login bug" },
    ]);
  }),
);

it.effect.each([
  { name: "a blank title", input: { title: "   " }, code: "invalid_request" },
  {
    name: "a read-only client",
    input: { title: "New title", access: "read-only" as const },
    code: "capability_denied",
  },
  {
    name: "a caller whose run ended",
    input: { title: "New title", activeRunId: null },
    code: "parent_not_active",
  },
])("refuses $name without dispatching", ({ input, code }) =>
  Effect.gen(function* () {
    const { result, dispatched } = yield* rename(input);
    expect(result).toMatchObject({ _tag: "OrchestratorMcpFailure", code });
    expect(dispatched).toEqual([]);
  }),
);
