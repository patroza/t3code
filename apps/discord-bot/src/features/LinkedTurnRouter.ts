// @effect-diagnostics anyUnknownInErrorContext:off missingEffectContext:off globalDate:off globalErrorInEffectFailure:off outdatedApi:off
import type { UploadChatAttachment } from "@t3tools/contracts";
import { DiscordREST } from "dfx";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

import type { DiscordBotConfig } from "../config.ts";
import { workingMessageFields } from "../presentation/messages.ts";
import {
  buildFirstTurnPrompt,
  looksLikeSentryContext,
  type DiscordMessageLike,
} from "../presentation/threadContext.ts";
import { ProjectAliasStore } from "../projectAliases.ts";
import { ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { T3Session } from "../t3/T3Session.ts";
import { bridgeThreadToDiscord } from "./ResponseBridge.ts";

export interface LinkedTurnFlags {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly base?: string | undefined;
  readonly local?: boolean | undefined;
  readonly plan?: boolean | undefined;
}

export interface LinkedTurnSource {
  readonly sourceKind: "discord" | "teams";
  readonly sourceThreadId: string;
}

export interface LinkedTurnPromptContext {
  readonly kind: "discord";
  readonly topic: string | null | undefined;
  readonly mentionMessage?: DiscordMessageLike | undefined;
  readonly starter?: DiscordMessageLike | null | undefined;
}

export interface LinkedTurnInput {
  readonly source: LinkedTurnSource;
  readonly discordThreadId: string;
  readonly discordParentChannelId: string;
  readonly discordGuildId: string;
  readonly projectShortName: string;
  readonly prompt: string;
  readonly flags: LinkedTurnFlags;
  readonly stickyModelOnContinue?: boolean | undefined;
  readonly attachments?: ReadonlyArray<UploadChatAttachment> | undefined;
  readonly announceLines: ReadonlyArray<string>;
  readonly promptContext?:
    | LinkedTurnPromptContext
    | {
        readonly kind: "raw";
        readonly value: string;
      }
    | undefined;
}

export interface TransportNeutralLinkedTurnInput {
  readonly source: LinkedTurnSource;
  /** Stable delivery/conversation id. Stored in the legacy discordThreadId field for v2 links. */
  readonly externalConversationId: string;
  readonly externalParentId: string;
  readonly externalTenantId: string;
  readonly projectShortName: string;
  readonly prompt: string;
  readonly flags: LinkedTurnFlags;
  readonly stickyModelOnContinue?: boolean | undefined;
  readonly attachments?: ReadonlyArray<UploadChatAttachment> | undefined;
  readonly promptContext?: LinkedTurnInput["promptContext"];
}

/**
 * Shared start/continue path for Discord mentions and Teams intake.
 * Ported from aaaomega/t3code-pvt#1 and adapted to the current ThreadLinkStore + bridge APIs.
 */
export const resolveProjectFromShortName = Effect.fn("resolveProjectFromShortName")(function* (
  projectShortName: string,
) {
  const aliases = yield* ProjectAliasStore;
  const t3 = yield* T3Session;

  const alias = aliases.resolve(projectShortName);
  if (alias === null) {
    return yield* Effect.fail(
      `Unknown project alias '${projectShortName}'. Add it to the bot aliases file (T3_PROJECT_ALIASES_PATH).` as const,
    );
  }
  const project = yield* t3.findProjectByWorkspaceRoot(alias.workspaceRoot);
  if (project === null) {
    return yield* Effect.fail(
      `No T3 project registered at ${alias.workspaceRoot} (alias '${projectShortName}'). Add the project in T3 first.` as const,
    );
  }

  return { alias, project };
});

/**
 * Transport-neutral T3 start/continue path. Discord and Teams own their presentation and
 * delivery lifecycle, while this function owns project resolution, model selection, T3
 * orchestration, and the durable source-conversation link.
 */
export const startOrContinueT3Turn = Effect.fn("startOrContinueT3Turn")(function* (
  config: DiscordBotConfig,
  input: TransportNeutralLinkedTurnInput,
) {
  const t3 = yield* T3Session;
  const links = yield* ThreadLinkStore;
  const attachments = input.attachments ?? [];
  const hasExplicitModelFlags =
    input.flags.provider !== undefined || input.flags.model !== undefined;
  const resolved = yield* resolveProjectFromShortName(input.projectShortName);
  const existing = yield* links.getBySourceThread(
    input.source.sourceKind,
    input.source.sourceThreadId,
  );

  if (existing !== null) {
    const continueModelSelection =
      input.stickyModelOnContinue === true && !hasExplicitModelFlags
        ? undefined
        : yield* t3.resolveModelSelection({
            project: resolved.project,
            ...(input.flags.provider === undefined
              ? {}
              : { overrideInstanceId: input.flags.provider }),
            ...(input.flags.model === undefined ? {} : { overrideModel: input.flags.model }),
          });
    yield* t3.startTurn({
      threadId: existing.t3ThreadId,
      prompt: input.prompt,
      ...(continueModelSelection === undefined ? {} : { modelSelection: continueModelSelection }),
      ...(input.flags.plan ? { interactionMode: "plan" as const } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
    });
    return { threadId: existing.t3ThreadId, isNew: false } as const;
  }

  const modelSelection = yield* t3.resolveModelSelection({
    project: resolved.project,
    ...(input.flags.provider === undefined ? {} : { overrideInstanceId: input.flags.provider }),
    ...(input.flags.model === undefined ? {} : { overrideModel: input.flags.model }),
  });
  const enrichedPrompt = resolveInitialPrompt({
    config,
    projectShortName: input.projectShortName,
    workspaceRoot: resolved.project.workspaceRoot,
    prompt: input.prompt,
    promptContext: input.promptContext,
    guildId: input.externalTenantId,
    discordThreadId: input.externalConversationId,
  });
  const { threadId } = yield* t3.startTurnWithWorktree({
    project: resolved.project,
    prompt: enrichedPrompt,
    modelSelection,
    interactionMode: input.flags.plan ? "plan" : "default",
    baseBranch: input.flags.base ?? config.t3DefaultBaseBranch,
    local: input.flags.local ?? false,
    ...(attachments.length > 0 ? { attachments } : {}),
  });

  yield* links.put({
    sourceKind: input.source.sourceKind,
    sourceThreadId: input.source.sourceThreadId,
    discordThreadId: input.externalConversationId,
    t3ThreadId: threadId,
    projectId: resolved.project.id,
    channelId: input.externalParentId,
    guildId: input.externalTenantId,
    createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
  });
  return { threadId, isNew: true } as const;
});

function resolveInitialPrompt(input: {
  readonly config: DiscordBotConfig;
  readonly projectShortName: string;
  readonly workspaceRoot: string;
  readonly prompt: string;
  readonly promptContext: LinkedTurnInput["promptContext"];
  readonly guildId: string;
  readonly discordThreadId: string;
}): string {
  if (input.promptContext?.kind === "raw") {
    return input.promptContext.value;
  }

  if (input.promptContext?.kind === "discord") {
    const starter = input.promptContext.starter ?? input.promptContext.mentionMessage ?? null;
    const sentryBootstrap = looksLikeSentryContext({
      starter,
      mentionPrompt: input.prompt,
    });
    if (sentryBootstrap || starter !== null) {
      return buildFirstTurnPrompt({
        starter,
        mentionMessage: input.promptContext.mentionMessage,
        mentionPrompt: input.prompt,
        projectShortName: input.projectShortName,
        workspaceRoot: input.workspaceRoot,
        honeycombTraceUrlTemplate: input.config.honeycombTraceUrlTemplate,
        jiraBrowseBaseUrl: input.config.jiraBrowseBaseUrl,
        guildId: input.guildId,
        discordThreadId: input.discordThreadId,
      });
    }
  }

  return input.prompt;
}

export const startOrContinueLinkedTurn = Effect.fn("startOrContinueLinkedTurn")(function* (
  config: DiscordBotConfig,
  input: LinkedTurnInput,
) {
  const rest = yield* DiscordREST;
  const links = yield* ThreadLinkStore;
  const existing = yield* links.getBySourceThread(
    input.source.sourceKind,
    input.source.sourceThreadId,
  );
  if (existing !== null) {
    const workingAckResult = yield* rest
      .createMessage(input.discordThreadId, {
        ...workingMessageFields("_Working.._", existing.t3ThreadId),
      })
      .pipe(
        Effect.map((message) => message.id as string),
        Effect.tap((messageId) => Effect.logInfo("Posted Working.. ack", { messageId })),
        Effect.result,
      );
    if (Result.isFailure(workingAckResult)) {
      yield* Effect.logError("Failed to post Working.. ack");
      yield* Effect.logError(workingAckResult.failure);
    }
    const workingAckMessageId = Result.isSuccess(workingAckResult)
      ? workingAckResult.success
      : null;

    yield* bridgeThreadToDiscord({
      discordChannelId: input.discordThreadId,
      t3ThreadId: existing.t3ThreadId,
      workingAckMessageId,
    });
  }

  const turn = yield* startOrContinueT3Turn(config, {
    source: input.source,
    externalConversationId: input.discordThreadId,
    externalParentId: input.discordParentChannelId,
    externalTenantId: input.discordGuildId,
    projectShortName: input.projectShortName,
    prompt: input.prompt,
    flags: input.flags,
    ...(input.stickyModelOnContinue === undefined
      ? {}
      : { stickyModelOnContinue: input.stickyModelOnContinue }),
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    ...(input.promptContext === undefined ? {} : { promptContext: input.promptContext }),
  });
  const threadId = turn.threadId;

  const webLink =
    config.webUiBaseUrl === undefined
      ? null
      : `${config.webUiBaseUrl.replace(/\/$/u, "")}/?thread=${threadId}`;

  if (turn.isNew) {
    yield* rest.createMessage(input.discordThreadId, {
      content: [...input.announceLines, webLink === null ? null : `Open in Omegent: ${webLink}`]
        .filter((line): line is string => line !== null && line.trim().length > 0)
        .join("\n"),
    });
  }

  yield* bridgeThreadToDiscord({
    discordChannelId: input.discordThreadId,
    t3ThreadId: threadId,
  });

  return threadId;
});
