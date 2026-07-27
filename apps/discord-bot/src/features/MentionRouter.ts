// @effect-diagnostics anyUnknownInErrorContext:off missingEffectContext:off globalDate:off globalErrorInEffectFailure:off outdatedApi:off globalFetchInEffect:off
import {
  MessageId,
  type ModelSelection,
  type OrchestrationThread,
  type ServerProvider,
  type ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { DISCORD_LINK_REQUEST_MARKER } from "@t3tools/shared/providerModelSelection";
import { Discord, DiscordREST, Ix } from "dfx";
import { DiscordGateway, InteractionsRegistry } from "dfx/gateway";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type { DiscordBotConfig } from "../config.ts";
import {
  appendDiscordAttachmentPromptBlock,
  ATTACHMENT_ONLY_PROMPT,
  downloadDiscordAttachmentsToWorkspace,
} from "../presentation/discordInboundFiles.ts";
import {
  downloadDiscordImagesAsUploadAttachments,
  filterDiscordImageAttachments,
  IMAGE_ONLY_PROMPT,
  type DiscordInboundAttachment,
} from "../presentation/discordInboundImages.ts";
import {
  bridgedTurnTopicResolutionError,
  missingProjectBindingMessage,
  parseMentionFlags,
  parseMentionIntent,
  parseTopicShortName,
  projectTopicFromParentLookup,
  normalizeWorkspacePath,
  resolveDiscordFollowUpDelivery,
  type ProjectTopicLookup,
} from "../presentation/mentions.ts";
import {
  extractJiraIssueKeysFromDiscordMessage,
  mergeJiraIssueKeys,
} from "../presentation/jiraLinks.ts";
import { extractPullRequestUrlsFromDiscordMessage } from "../presentation/prLinks.ts";
import {
  idleMessageFields,
  stripBotMention,
  truncateTitle,
  turnContinueCustomId,
  turnStopCustomId,
  workingMessageFields,
} from "../presentation/messages.ts";
import {
  formatAskSlashAck,
  isThreadTalkSlashAction,
  OMEGENT_SLASH_COMMAND,
  OMEGENT_SLASH_COMMAND_ALIAS,
  OMEGENT_SLASH_COMMAND_NAME,
  slashDefer,
  slashReply,
  threadTalkSlashReply,
} from "../presentation/slashCommands.ts";
import { extractT3ThreadId } from "../presentation/t3ThreadRef.ts";
import {
  buildDiscordTurnPrompt,
  buildFirstTurnPrompt,
  looksLikeSentryContext,
  type DiscordMessageLike,
} from "../presentation/threadContext.ts";
import { ProjectAliasStore } from "../projectAliases.ts";
import { type ThreadLink, ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { newMessageId } from "../t3/ids.ts";
import { T3Session, T3SessionError } from "../t3/T3Session.ts";
import { formatAlertCause } from "./Alerts.ts";
import { ensureChannelInfoPin } from "./ChannelInfoPin.ts";
import { makeDiscordThreadTurnCoordinator } from "./DiscordThreadTurnCoordinator.ts";
import {
  createDiscordQueuedPromptRegistry,
  formatSteernowEmptyQueueMessage,
  QUEUED_PROMPT_REACTION_EMOJI,
  resolveSteernowMessageIds,
} from "./DiscordQueuedPromptRegistry.ts";
import { BridgeHub } from "./BridgeHub.ts";
import { bridgeThreadToDiscord, getLiveDiscordBridge } from "./ResponseBridge.ts";
import { upsertThreadInfoPin } from "./ThreadInfoPin.ts";
import {
  formatUnmentionedDiscordPrompt,
  parseThreadTalkCommand,
  threadTalkEnabled,
} from "./ThreadTalkPolicy.ts";

/** Marker service so the process must acquire the mention router layer. */
export class DiscordBotRunning extends Context.Service<
  DiscordBotRunning,
  { readonly botUserId: string }
>()("@t3tools/discord-bot/features/MentionRouter/DiscordBotRunning") {}

class DiscordImageDownloadError extends Schema.TaggedErrorClass<DiscordImageDownloadError>()(
  "DiscordImageDownloadError",
  { cause: Schema.Defect() },
) {}

class DiscordAttachmentStageError extends Schema.TaggedErrorClass<DiscordAttachmentStageError>()(
  "DiscordAttachmentStageError",
  { cause: Schema.Defect() },
) {}

const MAX_HANDLED_MESSAGE_IDS = 2048;

export function createHandledDiscordMessageTracker(limit = MAX_HANDLED_MESSAGE_IDS) {
  const handled = new Set<string>();
  const insertionOrder: string[] = [];

  const record = (messageId: string): boolean => {
    if (handled.has(messageId)) return false;
    handled.add(messageId);
    insertionOrder.push(messageId);
    while (insertionOrder.length > limit) {
      const oldest = insertionOrder.shift();
      if (oldest !== undefined) handled.delete(oldest);
    }
    return true;
  };

  return {
    has(messageId: string) {
      return handled.has(messageId);
    },
    /** Record that a message id was handled (idempotent). */
    mark(messageId: string) {
      record(messageId);
    },
    /**
     * Atomically claim a Discord message id for routing.
     * Returns false when another create/update path already claimed it.
     */
    claim(messageId: string) {
      return record(messageId);
    },
  };
}

function isThreadChannel(type: number | undefined): boolean {
  return type === 10 || type === 11 || type === 12;
}

function mentionsBotInContent(content: string, botUserId: string): boolean {
  return content.includes(`<@${botUserId}>`) || content.includes(`<@!${botUserId}>`);
}

function mentionsBotInEvent(
  event: {
    readonly content?: string | null;
    readonly mentions?: ReadonlyArray<{ readonly id?: string }> | null;
  },
  botUserId: string,
): boolean {
  if (mentionsBotInContent(event.content ?? "", botUserId)) return true;
  return event.mentions?.some((user) => user.id === botUserId) ?? false;
}

function discordMessageFromEvent(event: {
  readonly id: string;
  readonly content?: string | null | undefined;
  readonly channel_id?: string | undefined;
  readonly author?:
    | {
        readonly id?: string | undefined;
        readonly username?: string | undefined;
        readonly global_name?: string | null | undefined;
        readonly bot?: boolean | undefined;
      }
    | undefined;
  readonly member?: { readonly nick?: string | null | undefined } | undefined;
  readonly embeds?: DiscordMessageLike["embeds"];
  readonly timestamp?: string | undefined;
}): DiscordMessageLike {
  return {
    id: event.id,
    content: event.content,
    author: {
      id: event.author?.id,
      username: event.author?.username,
      displayName:
        event.member?.nick ?? event.author?.global_name ?? event.author?.username ?? undefined,
      bot: event.author?.bot,
    },
    embeds: event.embeds,
    timestamp: event.timestamp,
    ...(typeof event.channel_id === "string" ? { channelId: event.channel_id } : {}),
  };
}

function hasInterruptibleTurn(
  thread: {
    readonly latestTurn?: { readonly state?: string | null } | null;
    readonly session?: { readonly status?: string | null } | null;
  } | null,
): boolean {
  return (
    thread?.latestTurn?.state === "running" ||
    thread?.session?.status === "running" ||
    thread?.session?.status === "starting"
  );
}

function discordMessageUrl(
  guildId: string | null | undefined,
  channelId: string,
  messageId: string,
): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}/${messageId}`;
}

type DiscordMessagePayload = {
  readonly id: string;
  readonly content?: string | null | undefined;
  readonly channel_id?: string | undefined;
  readonly author?:
    | {
        readonly id?: string | undefined;
        readonly username?: string | undefined;
        readonly global_name?: string | null | undefined;
        readonly bot?: boolean | undefined;
      }
    | undefined;
  readonly member?: { readonly nick?: string | null | undefined } | undefined;
  readonly embeds?: DiscordMessageLike["embeds"];
  readonly timestamp?: string | undefined;
};

/**
 * Resolve the message the user replied to / referenced.
 * Gateway often includes `referenced_message` for REPLY; otherwise fetch via REST
 * using `message_reference` so Sentry embeds and other context reach the agent.
 */
function resolveReferencedMessage(input: {
  readonly event: {
    readonly channel_id: string;
    readonly guild_id?: string | null | undefined;
    readonly referenced_message?: DiscordMessagePayload | null | undefined;
    readonly message_reference?:
      | {
          readonly message_id?: string | null | undefined;
          readonly channel_id?: string | null | undefined;
          readonly guild_id?: string | null | undefined;
        }
      | null
      | undefined;
  };
  readonly rest: {
    // Discord REST message shape is wider than DiscordMessagePayload; map at the boundary.
    readonly getMessage: (
      channelId: string,
      messageId: string,
    ) => Effect.Effect<DiscordMessagePayload, unknown>;
  };
}): Effect.Effect<{ message: DiscordMessageLike; url: string } | null> {
  return Effect.gen(function* () {
    const gatewayRef = input.event.referenced_message;
    if (gatewayRef !== null && gatewayRef !== undefined && typeof gatewayRef.id === "string") {
      const channelId =
        typeof gatewayRef.channel_id === "string"
          ? gatewayRef.channel_id
          : (input.event.message_reference?.channel_id ?? input.event.channel_id);
      const guildId = input.event.message_reference?.guild_id ?? input.event.guild_id ?? null;
      return {
        message: discordMessageFromEvent({
          ...gatewayRef,
          channel_id: channelId,
        }),
        url: discordMessageUrl(guildId, channelId, gatewayRef.id),
      };
    }

    const refId = input.event.message_reference?.message_id;
    if (refId === null || refId === undefined || refId === "") {
      return null;
    }
    const channelId = input.event.message_reference?.channel_id ?? input.event.channel_id;
    const guildId = input.event.message_reference?.guild_id ?? input.event.guild_id ?? null;
    const fetched = yield* input.rest.getMessage(channelId, refId).pipe(
      Effect.map(
        (message): DiscordMessageLike =>
          discordMessageFromEvent({
            ...message,
            channel_id: typeof message.channel_id === "string" ? message.channel_id : channelId,
          }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Failed to fetch referenced Discord message", {
          channelId,
          messageId: refId,
          error: String(error),
        }).pipe(Effect.as(null as DiscordMessageLike | null)),
      ),
    );
    if (fetched === null) return null;
    return {
      message: fetched,
      url: discordMessageUrl(guildId, channelId, refId),
    };
  });
}

function discordChannelUrl(guildId: string | null | undefined, channelId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}`;
}

function t3WebThreadUrl(webUiBaseUrl: string | undefined, threadId: string): string | null {
  if (webUiBaseUrl === undefined) return null;
  return `${webUiBaseUrl.replace(/\/$/u, "")}/?thread=${threadId}`;
}

function jiraKeysFromMessages(
  ...messages: ReadonlyArray<
    DiscordMessageLike | null | undefined | { readonly content?: string | null }
  >
): ReadonlyArray<string> {
  const keys: string[] = [];
  for (const message of messages) {
    if (message === null || message === undefined) continue;
    keys.push(...extractJiraIssueKeysFromDiscordMessage(message));
  }
  return keys;
}

function prUrlsFromMessages(
  ...messages: ReadonlyArray<
    DiscordMessageLike | null | undefined | { readonly content?: string | null }
  >
): ReadonlyArray<string> {
  const urls: string[] = [];
  for (const message of messages) {
    if (message === null || message === undefined) continue;
    urls.push(...extractPullRequestUrlsFromDiscordMessage(message));
  }
  return urls;
}

export function findDiscordLinkForT3Target(input: {
  readonly links: ReadonlyArray<ThreadLink>;
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly worktreePath: string | null;
  }>;
  readonly target: { readonly id: ThreadId; readonly worktreePath: string | null };
}): ThreadLink | undefined {
  const direct = input.links.find((link) => link.t3ThreadId === input.target.id);
  if (direct !== undefined || input.target.worktreePath === null) return direct;
  const targetWorktree = normalizeWorkspacePath(input.target.worktreePath);
  return input.links.find((link) => {
    const linkedThread = input.threads.find((thread) => thread.id === link.t3ThreadId);
    return (
      linkedThread?.worktreePath !== null &&
      linkedThread?.worktreePath !== undefined &&
      normalizeWorkspacePath(linkedThread.worktreePath) === targetWorktree
    );
  });
}

/**
 * Durable link exists but setup never finished (e.g. slash `/link` died after
 * `links.put` before bridge/pin). Re-link / re-attach should complete setup.
 *
 * Detected via missing thread-info pin id — not snapshot sequence (idle links
 * often keep a null sequence until the first live bridge snapshot).
 */
export function isIncompleteDiscordLink(link: {
  readonly infoDiscordMessageId?: string | undefined;
}): boolean {
  return link.infoDiscordMessageId === undefined || link.infoDiscordMessageId.length === 0;
}

/**
 * `@Omegent` in Discord is ambiguous: it can resolve to the bot USER (`<@id>`) or to the
 * app's managed ROLE (`<@&id>`), which render near-identically in the picker. Only the
 * user form populates `mentions`, so a role ping used to be silently ignored.
 *
 * We match ONLY the app's own managed role -- the one Discord auto-creates, identified by
 * `tags.bot_id === botUserId`. Matching any role the bot merely belongs to would make it
 * respond to every `@engineers` message, which is much worse than the original bug.
 */
function botManagedRoleIdFrom(
  roles: ReadonlyArray<{
    readonly id?: string;
    readonly tags?: { readonly bot_id?: string | undefined } | null | undefined;
  }>,
  botUserId: string,
): string | null {
  return roles.find((role) => role.tags?.bot_id === botUserId)?.id ?? null;
}

export function getContinuedConversationModelChangeError(input: {
  readonly providers: ReadonlyArray<
    Pick<ServerProvider, "driver" | "instanceId" | "requiresNewThreadForModelChange">
  >;
  readonly currentModelSelection: ModelSelection;
  readonly nextModelSelection: ModelSelection;
}): string | null {
  if (
    input.currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    input.currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }

  const currentProvider = input.providers.find(
    (provider) => provider.instanceId === input.currentModelSelection.instanceId,
  );
  const nextProvider = input.providers.find(
    (provider) => provider.instanceId === input.nextModelSelection.instanceId,
  );

  if (
    currentProvider?.driver !== undefined &&
    nextProvider?.driver !== undefined &&
    currentProvider.driver !== nextProvider.driver
  ) {
    return "This Discord conversation can only switch models within the same provider. Start a new Discord thread to switch providers.";
  }

  if (
    currentProvider?.requiresNewThreadForModelChange === true ||
    nextProvider?.requiresNewThreadForModelChange === true
  ) {
    return "This provider does not allow switching models after the conversation has started. Start a new Discord thread to use that model.";
  }

  return null;
}

type BridgedTurnInput = {
  readonly discordThreadId: string;
  readonly channelId: string;
  readonly guildId: string;
  readonly prompt: string;
  readonly flags: ReturnType<typeof parseMentionFlags>;
  readonly topic: string | null | undefined;
  /** True when parent-channel topic could not be fetched (Discord outage / API error). */
  readonly parentUnavailable?: boolean;
  readonly parentChannelId: string | null;
  readonly mentionMessage?: DiscordMessageLike;
  /** Message the user replied to when addressing the bot (gateway or REST). */
  readonly referencedMessage?: DiscordMessageLike | null;
  readonly referencedMessageUrl?: string;
  readonly discordAttachments?: ReadonlyArray<DiscordInboundAttachment>;
  readonly attachments?: ReadonlyArray<UploadChatAttachment>;
  readonly presentationMode?: "full" | "final-only";
};

const make = (botConfig: DiscordBotConfig) =>
  Effect.gen(function* () {
    const gateway = yield* DiscordGateway;
    const rest = yield* DiscordREST;
    const t3 = yield* T3Session;
    const links = yield* ThreadLinkStore;
    const aliases = yield* ProjectAliasStore;
    const registry = yield* InteractionsRegistry;
    const bridgeHub = yield* BridgeHub;
    const turnCoordinator = yield* makeDiscordThreadTurnCoordinator;
    const queuedPrompts = createDiscordQueuedPromptRegistry();

    const markDiscordPromptQueued = (input: {
      readonly discordChannelId: string;
      readonly discordMessageId: string;
      readonly t3ThreadId: ThreadId;
      readonly t3MessageId: MessageId;
      readonly authorUserId: string | null;
    }) =>
      Effect.gen(function* () {
        queuedPrompts.remember(input);
        yield* rest
          .addMyMessageReaction(
            input.discordChannelId,
            input.discordMessageId,
            QUEUED_PROMPT_REACTION_EMOJI,
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to add queued badge reaction", {
                discordMessageId: input.discordMessageId,
                error: String(error),
              }),
            ),
          );
      });

    const clearQueuedBadge = (entry: {
      readonly discordChannelId: string;
      readonly discordMessageId: string;
    }) =>
      rest
        .deleteMyMessageReaction(
          entry.discordChannelId,
          entry.discordMessageId,
          QUEUED_PROMPT_REACTION_EMOJI,
        )
        .pipe(Effect.catch(() => Effect.void));

    // Mentions use the bot *user* id, not the application id.
    const me = yield* rest.getMyUser();
    const botUserId = me.id;
    yield* Effect.logInfo("Discord bot identity", {
      botUserId,
      username: me.username,
    });

    // Prove the sharder is alive (non-empty after READY).
    yield* Effect.forkScoped(
      Effect.gen(function* () {
        yield* Effect.sleep("3 seconds");
        const shards = yield* gateway.shards;
        yield* Effect.logInfo("Discord shard status", {
          shardCount: shards.size,
        });
      }),
    );

    /**
     * Retry briefly on transient Discord REST failures (outages, 5xx, rate-limit blips).
     * Three attempts with short backoff (~200ms, ~400ms) before treating the parent as unavailable.
     */
    const getChannelWithRetry = (channelId: string) =>
      Effect.gen(function* () {
        let lastFailure: unknown;
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const result = yield* rest.getChannel(channelId).pipe(Effect.result);
          if (Result.isSuccess(result)) return result.success;
          lastFailure = result.failure;
          if (attempt < 2) {
            yield* Effect.sleep(`${200 * (attempt + 1)} millis` as const);
          }
        }
        return yield* Effect.fail(lastFailure);
      });

    /**
     * Resolve project-binding topic for a channel or thread.
     * Retries parent GET; never confuses a failed parent fetch with a missing `t3-*` tag.
     */
    const resolveProjectTopic = (channel: {
      readonly type?: number | undefined;
      readonly parent_id?: string | null | undefined;
      readonly topic?: string | null | undefined;
    }): Effect.Effect<ProjectTopicLookup> =>
      Effect.gen(function* () {
        const inThread = isThreadChannel(channel.type);
        const parentId =
          inThread && typeof channel.parent_id === "string" ? channel.parent_id : null;
        if (parentId === null) {
          return projectTopicFromParentLookup({
            channel,
            parentId: null,
            parent: null,
          });
        }
        const parentResult = yield* getChannelWithRetry(parentId).pipe(Effect.result);
        if (Result.isFailure(parentResult)) {
          const cause = String(parentResult.failure);
          yield* Effect.logWarning("Failed to fetch parent channel for project topic", {
            parentId,
            cause,
          });
          return projectTopicFromParentLookup({
            channel,
            parentId,
            parent: { ok: false, cause },
          });
        }
        return projectTopicFromParentLookup({
          channel,
          parentId,
          parent: { ok: true, channel: parentResult.success },
        });
      });

    const resolveProjectFromTopic = (topic: string | null | undefined) =>
      Effect.gen(function* () {
        const shortName = parseTopicShortName(topic);
        if (shortName === null) {
          return yield* Effect.fail("Channel topic has no t3-<shortName> tag." as const);
        }
        const alias = aliases.resolve(shortName);
        if (alias === null) {
          return yield* Effect.fail(
            `Unknown project alias '${shortName}'. Add it to the bot aliases file (T3_PROJECT_ALIASES_PATH).` as const,
          );
        }
        const project = yield* t3.findProjectByWorkspaceRoot(alias.workspaceRoot);
        if (project === null) {
          return yield* Effect.fail(
            `No T3 project registered at ${alias.workspaceRoot} (alias '${shortName}'). Add the project in T3 first.` as const,
          );
        }
        return { shortName, alias, project };
      });

    const refreshChannelInfoPin = (channelId: string, topic: string | null | undefined) =>
      Effect.gen(function* () {
        const shortName = parseTopicShortName(topic);
        if (shortName === null) return null;
        const alias = aliases.resolve(shortName);
        if (alias === null) return null;
        const project = yield* t3.findProjectByWorkspaceRoot(alias.workspaceRoot);
        const serverConfig = yield* t3.serverConfig();
        return yield* ensureChannelInfoPin({
          channelId,
          workspaceRoot: alias.workspaceRoot,
          providers: serverConfig?.providers ?? [],
          projectDefaultModelSelection: project?.defaultModelSelection ?? null,
          botConfig,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to refresh channel info pin", {
              channelId,
              shortName,
              error: String(error),
            }).pipe(Effect.as(null)),
          ),
        );
      });

    /** Resolve project binding for slash/mention help with specific failure reasons. */
    const resolveHelpChannelBinding = (channelId: string, topic: string | null | undefined) =>
      Effect.gen(function* () {
        const shortName = parseTopicShortName(topic);
        if (shortName === null) {
          return {
            kind: "no-topic" as const,
          };
        }
        const alias = aliases.resolve(shortName);
        if (alias === null) {
          return {
            kind: "unknown-alias" as const,
            shortName,
          };
        }
        const project = yield* t3.findProjectByWorkspaceRoot(alias.workspaceRoot);
        if (project === null) {
          return {
            kind: "no-project" as const,
            shortName,
            workspaceRoot: alias.workspaceRoot,
          };
        }
        const serverConfig = yield* t3.serverConfig();
        const pin = yield* ensureChannelInfoPin({
          channelId,
          workspaceRoot: alias.workspaceRoot,
          providers: serverConfig?.providers ?? [],
          projectDefaultModelSelection: project.defaultModelSelection ?? null,
          botConfig,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to refresh channel info pin", {
              channelId,
              shortName,
              error: String(error),
            }).pipe(Effect.as(null)),
          ),
        );
        if (pin === null) {
          return {
            kind: "pin-failed" as const,
            shortName,
            workspaceRoot: alias.workspaceRoot,
          };
        }
        return {
          kind: "ok" as const,
          shortName,
          pin,
        };
      });

    /**
     * For public threads created from a message, Discord uses the starter message id
     * as the thread id. Prefer parent channel + thread id; fall back to oldest thread msgs.
     */
    const loadThreadStarter = (input: {
      readonly discordThreadId: string;
      readonly parentChannelId: string | null;
      /** When the mention itself started the thread, use it as starter. */
      readonly mentionMessage?: DiscordMessageLike;
    }) =>
      Effect.gen(function* () {
        if (input.parentChannelId !== null) {
          const fromParent = yield* rest
            .getMessage(input.parentChannelId, input.discordThreadId)
            .pipe(
              Effect.map((message): DiscordMessageLike => message),
              Effect.orElseSucceed(() => null as DiscordMessageLike | null),
            );
          if (fromParent !== null) return fromParent;
        }

        const listed = yield* rest
          .listMessages(input.discordThreadId, { limit: 5, after: "0" })
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<DiscordMessageLike>));
        // listMessages returns newest-first by default; with after:0 we get oldest available.
        const oldest = listed.at(-1) ?? listed[0];
        if (oldest !== undefined) return oldest;

        return input.mentionMessage ?? null;
      });

    const startBridgedTurnUnlocked = (input: BridgedTurnInput) =>
      Effect.gen(function* () {
        // Only --provider / --model count as an explicit model change. Bare mentions must
        // NOT re-apply bot defaults (codex/gpt-5.4) on continue — Grok (and others) refuse
        // mid-thread model switches with "cannot switch models after the conversation has started".
        const hasExplicitModelFlags =
          input.flags.provider !== undefined || input.flags.model !== undefined;
        const attachments = input.attachments ?? [];
        const parentUnavailable = input.parentUnavailable === true;

        const existing = yield* links.getByDiscordThreadId(input.discordThreadId);

        // Topic is preferred; during Discord outages fall back to the project already on the
        // Discord↔T3 link so continue turns still work instead of "no t3-<shortName> tag".
        const fromTopic = yield* resolveProjectFromTopic(input.topic).pipe(Effect.result);
        const resolved = yield* Effect.gen(function* () {
          if (Result.isSuccess(fromTopic)) return fromTopic.success;

          if (existing !== null) {
            const project = yield* t3.getProjectShell(existing.projectId);
            if (project !== null) {
              yield* Effect.logWarning(
                "Channel topic unavailable; continuing with project from existing Discord link",
                {
                  discordThreadId: input.discordThreadId,
                  projectId: existing.projectId,
                  parentUnavailable,
                  topicError: fromTopic.failure,
                },
              );
              return {
                shortName: parseTopicShortName(input.topic) ?? "linked",
                alias: {
                  shortName: parseTopicShortName(input.topic) ?? "linked",
                  workspaceRoot: project.workspaceRoot,
                },
                project,
              };
            }
          }

          const error = bridgedTurnTopicResolutionError({
            topicError: fromTopic.failure,
            parentUnavailable,
            hasExistingLink: existing !== null,
            recoveredFromLink: false,
          });
          return yield* Effect.fail(
            (error ?? fromTopic.failure) as typeof fromTopic.failure | string,
          );
        });

        if (existing !== null) {
          const rest = yield* DiscordREST;
          const currentThread = yield* t3.getThreadShell(existing.t3ThreadId);
          const stagedFiles = yield* Effect.tryPromise({
            try: () =>
              downloadDiscordAttachmentsToWorkspace({
                attachments: input.discordAttachments ?? [],
                discordThreadId: input.discordThreadId,
                messageId: input.mentionMessage?.id ?? "message",
              }),
            catch: (cause) => new DiscordAttachmentStageError({ cause }),
          });
          const promptWithAttachments = appendDiscordAttachmentPromptBlock({
            prompt: input.prompt,
            attachments: stagedFiles.saved,
          });
          // Re-inject durable thread Jira keys so later turns (e.g. create PR) still see them.
          const turnJiraIssueKeys = mergeJiraIssueKeys(
            existing.jiraIssueKeys,
            jiraKeysFromMessages(input.mentionMessage, input.referencedMessage, {
              content: input.prompt,
            }),
          );
          const prompt = buildDiscordTurnPrompt({
            mentionPrompt: promptWithAttachments,
            requester: input.mentionMessage,
            referencedMessage: input.referencedMessage,
            referencedMessageUrl: input.referencedMessageUrl,
            jiraIssueKeys: turnJiraIssueKeys,
            jiraBrowseBaseUrl: botConfig.jiraBrowseBaseUrl,
          });
          if (stagedFiles.skipped.length > 0) {
            yield* Effect.logWarning("Skipped some Discord file attachments", {
              skipped: stagedFiles.skipped,
            });
          }
          const turnAlreadyRunning = hasInterruptibleTurn(currentThread);
          const liveBridge = yield* getLiveDiscordBridge(
            input.discordThreadId,
            existing.t3ThreadId,
          );
          // Mid-turn follow-up on a live bridge: keep steering via startTurn, but do not
          // post a fresh Working.. tip or restart the bridge (that used to freeze old
          // stream messages as "stale" and drop mid-turn Discord history).
          const reuseLiveBridge = turnAlreadyRunning && liveBridge !== null;
          yield* links.touch(input.discordThreadId).pipe(Effect.ignore);

          yield* Effect.logInfo("Resolved existing Discord↔T3 thread link", {
            discordThreadId: input.discordThreadId,
            t3ThreadId: existing.t3ThreadId,
            projectId: existing.projectId,
            createdAt: existing.createdAt,
            persistedTaskDiscordMessageId: existing.taskDiscordMessageId ?? null,
            persistedStreamDiscordMessageIds: existing.streamDiscordMessageIds ?? [],
            currentThreadTitle: currentThread?.title ?? null,
            currentThreadSessionStatus: currentThread?.session?.status ?? null,
            currentThreadTurnState: currentThread?.latestTurn?.state ?? null,
            turnAlreadyRunning,
            reuseLiveBridge,
          });
          yield* Effect.logInfo("Continuing linked T3 thread", {
            discordThreadId: input.discordThreadId,
            t3ThreadId: existing.t3ThreadId,
            explicitModelFlags: hasExplicitModelFlags,
            imageAttachments: attachments.length,
            stagedAttachments: stagedFiles.saved.length,
            turnAlreadyRunning,
            reuseLiveBridge,
          });

          // Always post a fresh Working.. tip for interactive continues — including mid-turn
          // steers while a live bridge is already streaming. Skipping the ack (old
          // reuseLiveBridge path) left Discord editing the *previous* Working+Stop above
          // the human message with no visible response to the new mention.
          // Live bridge adopts this id: freezes/clears old tip, streams under the new one.
          const workingAckMessageId =
            input.presentationMode === "final-only"
              ? null
              : yield* rest
                  .createMessage(input.discordThreadId, {
                    ...workingMessageFields("_Working.._", existing.t3ThreadId),
                  })
                  .pipe(
                    Effect.map((msg) => msg.id as string),
                    Effect.tap((messageId) =>
                      Effect.logInfo("Posted Working.. ack", {
                        messageId,
                        midTurnSteer: reuseLiveBridge,
                      }),
                    ),
                    Effect.result,
                    Effect.flatMap((result) => {
                      if (Result.isSuccess(result)) return Effect.succeed(result.success);
                      return Effect.logError("Failed to post Working.. ack").pipe(
                        Effect.andThen(Effect.logError(result.failure)),
                        Effect.as(null),
                      );
                    }),
                  );
          const pendingDiscordUserMessageId = newMessageId();

          // Ensure bridge (reuses live fiber for same thread; only restarts when needed).
          yield* bridgeThreadToDiscord({
            discordChannelId: input.discordThreadId,
            t3ThreadId: existing.t3ThreadId,
            workingAckMessageId,
            sentDiscordUserMessageIds: [pendingDiscordUserMessageId],
            ...(input.presentationMode === undefined
              ? {}
              : { presentationMode: input.presentationMode }),
          });
          yield* Effect.logInfo("Discord bridge ensure-started; dispatching startTurn", {
            t3ThreadId: existing.t3ThreadId,
            reuseLiveBridge,
          });

          // Omit modelSelection unless the user explicitly asked to switch — startTurn then
          // keeps thread.modelSelection (see T3Session.startTurn).
          const continueModelSelection = hasExplicitModelFlags
            ? yield* t3.resolveModelSelection({
                project: resolved.project,
                stickyModelSelection: currentThread?.modelSelection ?? null,
                ...(input.flags.provider === undefined
                  ? {}
                  : { overrideInstanceId: input.flags.provider }),
                ...(input.flags.model === undefined ? {} : { overrideModel: input.flags.model }),
              })
            : undefined;
          if (currentThread?.modelSelection !== undefined && continueModelSelection !== undefined) {
            const serverConfig = yield* t3.serverConfig();
            const error = getContinuedConversationModelChangeError({
              providers: serverConfig?.providers ?? [],
              currentModelSelection: currentThread.modelSelection,
              nextModelSelection: continueModelSelection,
            });
            if (error !== null) {
              return yield* Effect.fail(new T3SessionError(error));
            }
          }

          const startedTurn = yield* t3
            .startTurn({
              threadId: existing.t3ThreadId,
              prompt,
              messageId: pendingDiscordUserMessageId,
              ...(continueModelSelection === undefined
                ? {}
                : { modelSelection: continueModelSelection }),
              // Only --plan forces plan mode; bare mentions keep the thread's interaction mode.
              ...(input.flags.plan ? { interactionMode: "plan" as const } : {}),
              ...(attachments.length > 0 ? { attachments } : {}),
            })
            .pipe(
              Effect.tap(({ messageId }) =>
                Effect.gen(function* () {
                  yield* links.setSentDiscordUserMessageIds(input.discordThreadId, [
                    ...(existing.sentDiscordUserMessageIds ?? []),
                    messageId,
                    pendingDiscordUserMessageId,
                  ]);
                  // Always feed the real (and optimistic) user message id into the live
                  // bridge. We seed a placeholder before startTurn so the bridge is ready
                  // immediately; if T3 returns a different id (or we only updated the
                  // durable store), the bridge would treat this Discord turn as external
                  // input, mirror it back, and freeze the Working tip under that post.
                  const bridge =
                    liveBridge ??
                    (yield* getLiveDiscordBridge(input.discordThreadId, existing.t3ThreadId));
                  if (bridge !== null) {
                    yield* bridge.noteSentUserMessageIds([messageId, pendingDiscordUserMessageId]);
                  }
                }),
              ),
            );
          // Server parks busy-thread follow-ups. Default Discord policy is **queue**
          // (badge with 📥; delete user message to remove; /omegent steernow to flush).
          // `--steer` / `/omegent steer` inject immediately after startTurn.
          const followUpDelivery = resolveDiscordFollowUpDelivery(input.flags);
          const t3MessageId = MessageId.make(startedTurn.messageId);
          if (followUpDelivery === "steer" && turnAlreadyRunning) {
            const steered = yield* t3
              .steerQueuedMessage({
                threadId: existing.t3ThreadId,
                messageId: t3MessageId,
              })
              .pipe(
                Effect.tap(() =>
                  Effect.logInfo("Steered mid-turn Discord follow-up into active turn", {
                    t3ThreadId: existing.t3ThreadId,
                    messageId: startedTurn.messageId,
                  }),
                ),
                Effect.as(true),
                Effect.catch((error) =>
                  Effect.logWarning(
                    "Steer after startTurn failed; message may remain server-queued",
                    {
                      t3ThreadId: existing.t3ThreadId,
                      messageId: startedTurn.messageId,
                      error: String(error),
                    },
                  ).pipe(Effect.as(false)),
                ),
              );
            // If steer raced pending turn-start (or similar), keep the Discord-side
            // registry + 📥 badge so /omegent steernow can flush without waiting on
            // a lagging HTTP thread snapshot.
            if (!steered) {
              const discordMessageId =
                typeof input.mentionMessage?.id === "string" ? input.mentionMessage.id : null;
              if (discordMessageId !== null) {
                const authorUserId =
                  typeof input.mentionMessage?.author?.id === "string"
                    ? input.mentionMessage.author.id
                    : null;
                yield* markDiscordPromptQueued({
                  discordChannelId: input.discordThreadId,
                  discordMessageId,
                  t3ThreadId: existing.t3ThreadId,
                  t3MessageId,
                  authorUserId,
                });
              }
            }
          } else if (followUpDelivery === "queue" && turnAlreadyRunning) {
            const discordMessageId =
              typeof input.mentionMessage?.id === "string" ? input.mentionMessage.id : null;
            if (discordMessageId !== null) {
              const authorUserId =
                typeof input.mentionMessage?.author?.id === "string"
                  ? input.mentionMessage.author.id
                  : null;
              yield* markDiscordPromptQueued({
                discordChannelId: input.discordThreadId,
                discordMessageId,
                t3ThreadId: existing.t3ThreadId,
                t3MessageId,
                authorUserId,
              });
            }
          }
          yield* Effect.logInfo("startTurn dispatched", {
            t3ThreadId: existing.t3ThreadId,
            messageId: startedTurn.messageId,
            followUpDelivery,
            turnAlreadyRunning,
            modelSelection: continueModelSelection
              ? `${continueModelSelection.instanceId}/${continueModelSelection.model}`
              : "thread-sticky",
            imageAttachments: attachments.length,
            stagedAttachments: stagedFiles.saved.length,
          });

          // Refresh pinned thread-info (model/worktree/Open in Omegent + newly mentioned Jira/PR links).
          const continueShell = currentThread ?? (yield* t3.getThreadShell(existing.t3ThreadId));
          yield* upsertThreadInfoPin({
            discordThreadId: input.discordThreadId,
            t3ThreadId: existing.t3ThreadId,
            botConfig,
            incomingJiraKeys: jiraKeysFromMessages(input.mentionMessage, input.referencedMessage, {
              content: input.prompt,
            }),
            incomingPrUrls: prUrlsFromMessages(input.mentionMessage, input.referencedMessage, {
              content: input.prompt,
            }),
            modelSelection: continueModelSelection ?? continueShell?.modelSelection ?? null,
            worktreePath: continueShell?.worktreePath ?? null,
            local: continueShell?.worktreePath === null,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to refresh thread info pin", {
                discordThreadId: input.discordThreadId,
                error: String(error),
              }),
            ),
          );

          return existing.t3ThreadId;
        }

        // New Discord thread / first link: pick model from flags or bot defaults.
        const modelSelection = yield* t3.resolveModelSelection({
          project: resolved.project,
          ...(input.flags.provider === undefined
            ? {}
            : { overrideInstanceId: input.flags.provider }),
          ...(input.flags.model === undefined ? {} : { overrideModel: input.flags.model }),
        });

        // First link into this Discord thread: pull starter; Sentry bootstrap only when relevant.
        const starter = yield* loadThreadStarter({
          discordThreadId: input.discordThreadId,
          parentChannelId: input.parentChannelId,
          ...(input.mentionMessage === undefined ? {} : { mentionMessage: input.mentionMessage }),
        });
        const stagedFiles = yield* Effect.tryPromise({
          try: () =>
            downloadDiscordAttachmentsToWorkspace({
              attachments: input.discordAttachments ?? [],
              discordThreadId: input.discordThreadId,
              messageId: input.mentionMessage?.id ?? "message",
            }),
          catch: (cause) => new DiscordAttachmentStageError({ cause }),
        });
        const prompt = appendDiscordAttachmentPromptBlock({
          prompt: input.prompt,
          attachments: stagedFiles.saved,
        });
        if (stagedFiles.skipped.length > 0) {
          yield* Effect.logWarning("Skipped some Discord file attachments", {
            skipped: stagedFiles.skipped,
          });
        }

        const sentryBootstrap = looksLikeSentryContext({
          starter,
          mentionPrompt: prompt,
          referencedMessage: input.referencedMessage,
        });
        const firstTurnJiraIssueKeys = jiraKeysFromMessages(
          starter,
          input.mentionMessage,
          input.referencedMessage,
          { content: input.prompt },
        );
        const enrichedPrompt = buildFirstTurnPrompt({
          starter,
          mentionMessage: input.mentionMessage,
          referencedMessage: input.referencedMessage,
          referencedMessageUrl: input.referencedMessageUrl,
          mentionPrompt: prompt,
          projectShortName: resolved.shortName,
          workspaceRoot: resolved.project.workspaceRoot,
          honeycombTraceUrlTemplate: botConfig.honeycombTraceUrlTemplate,
          jiraIssueKeys: firstTurnJiraIssueKeys,
          jiraBrowseBaseUrl: botConfig.jiraBrowseBaseUrl,
        });

        yield* Effect.logInfo("Creating T3 thread with worktree bootstrap", {
          shortName: resolved.shortName,
          workspaceRoot: resolved.project.workspaceRoot,
          model: `${modelSelection.instanceId}/${modelSelection.model}`,
          hasStarterContext: starter !== null,
          starterAuthor: starter?.author?.username ?? null,
          hasReferencedMessage: input.referencedMessage != null,
          referencedMessageId: input.referencedMessage?.id ?? null,
          sentryBootstrap,
          imageAttachments: attachments.length,
          stagedAttachments: stagedFiles.saved.length,
        });

        const { threadId, messageId } = yield* t3.startTurnWithWorktree({
          project: resolved.project,
          prompt: enrichedPrompt,
          titleSeed: input.prompt,
          modelSelection,
          interactionMode: input.flags.plan ? "plan" : "default",
          baseBranch: input.flags.base ?? botConfig.t3DefaultBaseBranch,
          local: input.flags.local,
          ...(attachments.length > 0 ? { attachments } : {}),
        });
        yield* links.put({
          discordThreadId: input.discordThreadId,
          t3ThreadId: threadId,
          projectId: resolved.project.id,
          channelId: input.channelId,
          guildId: input.guildId,
          createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
          sentDiscordUserMessageIds: [messageId],
          jiraIssueKeys: firstTurnJiraIssueKeys,
          prUrls: prUrlsFromMessages(starter, input.mentionMessage, input.referencedMessage, {
            content: input.prompt,
          }),
        });
        yield* Effect.logInfo("Persisted new Discord↔T3 thread link", {
          discordThreadId: input.discordThreadId,
          t3ThreadId: threadId,
          projectId: resolved.project.id,
          channelId: input.channelId,
          guildId: input.guildId,
        });

        // Post the bare thread-info pin before the first Working tip so Discord shows the
        // pinned message first, but skip expensive repo lookups on this latency-sensitive
        // path. A richer refresh still runs after the bridge starts.
        yield* upsertThreadInfoPin({
          discordThreadId: input.discordThreadId,
          t3ThreadId: threadId,
          botConfig,
          incomingJiraKeys: firstTurnJiraIssueKeys,
          incomingPrUrls: prUrlsFromMessages(starter, input.mentionMessage, {
            content: input.prompt,
          }),
          modelSelection,
          baseBranchLabel: input.flags.base ?? botConfig.t3DefaultBaseBranch,
          local: input.flags.local,
          skipChannelRepoLookup: true,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to create initial thread info pin", {
              discordThreadId: input.discordThreadId,
              error: String(error),
            }),
          ),
        );

        // Critical path for first in-progress stream: Working tip + bridge MUST start
        // immediately after the initial pin. Agent work begins at startTurnWithWorktree;
        // keep the remaining path unchanged so the seeded Working tip and bridge delivery
        // retain their existing reliability on new thread starts.
        const workingAckMessageId =
          input.presentationMode === "final-only"
            ? null
            : yield* rest
                .createMessage(input.discordThreadId, {
                  ...workingMessageFields("_Working.._", threadId),
                })
                .pipe(
                  Effect.map((msg) => msg.id as string),
                  Effect.tap((postedId) =>
                    Effect.logInfo("Posted Working.. ack", { messageId: postedId }),
                  ),
                  Effect.result,
                  Effect.flatMap((result) => {
                    if (Result.isSuccess(result)) return Effect.succeed(result.success);
                    return Effect.logError("Failed to post Working.. ack").pipe(
                      Effect.andThen(Effect.logError(result.failure)),
                      Effect.as(null),
                    );
                  }),
                );

        yield* bridgeThreadToDiscord({
          discordChannelId: input.discordThreadId,
          t3ThreadId: threadId,
          workingAckMessageId,
          sentDiscordUserMessageIds: [messageId],
          ...(input.presentationMode === undefined
            ? {}
            : { presentationMode: input.presentationMode }),
        });

        // Refresh after bridge start to add any slower enrichment without blocking the
        // initial Working tip / stream subscription.
        yield* upsertThreadInfoPin({
          discordThreadId: input.discordThreadId,
          t3ThreadId: threadId,
          botConfig,
          incomingJiraKeys: firstTurnJiraIssueKeys,
          incomingPrUrls: prUrlsFromMessages(starter, input.mentionMessage, {
            content: input.prompt,
          }),
          modelSelection,
          baseBranchLabel: input.flags.base ?? botConfig.t3DefaultBaseBranch,
          local: input.flags.local,
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Failed to create thread info pin", {
              discordThreadId: input.discordThreadId,
              error: String(error),
            }),
          ),
        );

        return threadId;
      });

    const startBridgedTurn = (input: BridgedTurnInput) =>
      turnCoordinator.withLock(input.discordThreadId, startBridgedTurnUnlocked(input));

    const waitForStartedTurnToBecomeVisible = Effect.fn(
      "MentionRouter.waitForStartedTurnToBecomeVisible",
    )(function* (threadId: ThreadId) {
      for (let attempt = 0; attempt < 30; attempt += 1) {
        const thread = yield* t3.getThreadShell(threadId);
        if (hasInterruptibleTurn(thread)) return;
        yield* Effect.sleep("100 millis");
      }
      yield* Effect.logWarning("Started Discord thread-talk turn was not visible before timeout", {
        threadId,
      });
    });

    const reportError = (channelId: string, error: unknown) =>
      rest
        .createMessage(channelId, {
          content: `Could not start T3 turn: ${error instanceof Error ? error.message : String(error)}`,
        })
        .pipe(Effect.catchCause(Effect.logError), Effect.asVoid);

    /**
     * dfx InteractionsRegistry runs Ix handlers with a Discord-only context — app
     * services like {@link BridgeHub} are not ambient. Provide them explicitly for
     * anything that calls `bridgeThreadToDiscord` / `getLiveDiscordBridge`.
     */
    const withBridgeHub = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.provideService(BridgeHub, bridgeHub));

    /**
     * Background work from slash handlers. Must use `startImmediately: true` — dfx wraps
     * handlers in a short-lived Scope, and default forkDetach only schedules on the parent
     * dispatcher (often lost when the interaction fiber exits before the task runs).
     * Also re-provides BridgeHub (Ix fibers do not inherit the router layer context).
     */
    const forkSlashBackground = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      withBridgeHub(effect).pipe(Effect.forkDetach({ startImmediately: true }));

    /**
     * Link Discord to an existing T3 thread (no new T3 thread / no new turn).
     * Only from a project channel, or from a Discord thread that is not yet linked.
     * - If a Discord bridge already exists for that T3 thread, point at it.
     * - Else create a Discord thread from the mention (channel) or use the current
     *   unlinked Discord thread, then persist the link and ensure a bridge.
     */
    const replyFields = (replyToMessageId: string | null | undefined) =>
      replyToMessageId === null || replyToMessageId === undefined
        ? {}
        : { message_reference: { message_id: replyToMessageId } };

    /**
     * Link Discord to an existing T3 thread (no new T3 thread / no new turn).
     * Only from a project channel, or from a Discord thread that is not yet linked.
     * Returns a short user-facing summary (mention path posts it; slash uses it as the ack).
     */
    const linkExistingT3Thread = (input: {
      readonly t3ThreadId: string;
      readonly replyChannelId: string;
      /** Null when invoked from a slash command (no source message). */
      readonly replyToMessageId: string | null;
      readonly guildId: string;
      readonly topic: string | null | undefined;
      /** When already inside a Discord thread, link that thread instead of creating one. */
      readonly existingDiscordThreadId: string | null;
      readonly parentChannelId: string;
      /**
       * When true, skip `createMessage` on the reply channel and only return the summary
       * (caller responds via interaction ack). Still posts into a newly linked thread.
       */
      readonly replyViaReturn?: boolean;
    }) =>
      withBridgeHub(
        Effect.gen(function* () {
          const postReply = (content: string) =>
            input.replyViaReturn === true
              ? Effect.succeed(content)
              : rest
                  .createMessage(input.replyChannelId, {
                    content,
                    ...replyFields(input.replyToMessageId),
                  })
                  .pipe(Effect.as(content));

          // Refuse inside an already-linked Discord thread (same or different T3 id),
          // unless that link is incomplete (failed mid-setup) — then finish setup.
          if (input.existingDiscordThreadId !== null) {
            const currentLink = yield* links.getByDiscordThreadId(input.existingDiscordThreadId);
            if (
              currentLink !== null &&
              currentLink.status === "active" &&
              !isIncompleteDiscordLink(currentLink)
            ) {
              return yield* postReply(
                [
                  "This Discord thread is already linked to a T3 thread.",
                  "`link` / `pick-up` / `/omegent link` only works from a project channel, or from a Discord thread that is not linked yet.",
                  `Current T3 thread: \`${currentLink.t3ThreadId}\``,
                ].join("\n"),
              );
            }
          }

          const t3ThreadId = input.t3ThreadId as ThreadId;
          const shellThread = yield* t3.getThreadShell(t3ThreadId);
          if (shellThread === null) {
            return yield* postReply(`No T3 thread found for \`${input.t3ThreadId}\`.`);
          }

          const ensureLinkedBridgeAndPin = (args: {
            readonly discordThreadId: string;
            readonly titleLine: string;
            readonly extraLines?: ReadonlyArray<string>;
          }) =>
            Effect.gen(function* () {
              yield* bridgeThreadToDiscord({
                discordChannelId: args.discordThreadId,
                t3ThreadId,
              });
              yield* upsertThreadInfoPin({
                discordThreadId: args.discordThreadId,
                t3ThreadId,
                botConfig,
                incomingJiraKeys: [],
                modelSelection: shellThread.modelSelection,
                worktreePath: shellThread.worktreePath,
                local: shellThread.worktreePath === null,
                titleLine: args.titleLine,
                extraLines: [
                  "Mention me in this thread to continue the conversation.",
                  ...(args.extraLines ?? []),
                ],
              }).pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Failed to create thread info pin for linked thread", {
                    discordThreadId: args.discordThreadId,
                    t3ThreadId,
                    error: String(error),
                  }),
                ),
              );
            });

          const shell = yield* t3.shell();
          const existingLinks = yield* links.list();
          const activeLinks = existingLinks.filter((link) => link.status === "active");
          const existingLink =
            activeLinks.find((link) => link.t3ThreadId === t3ThreadId) ??
            (input.existingDiscordThreadId !== null
              ? activeLinks.find(
                  (link) =>
                    link.discordThreadId === input.existingDiscordThreadId &&
                    isIncompleteDiscordLink(link),
                )
              : undefined) ??
            findDiscordLinkForT3Target({
              links: activeLinks,
              threads: shell?.threads ?? [],
              target: { id: t3ThreadId, worktreePath: shellThread.worktreePath },
            });

          if (existingLink !== undefined) {
            if (existingLink.t3ThreadId !== t3ThreadId) {
              // Worktree match or incomplete Discord thread pointed at a different T3 id.
              yield* links.put({
                ...existingLink,
                t3ThreadId,
                projectId: shellThread.projectId,
              });
            }
            const recovering = isIncompleteDiscordLink(existingLink);
            const titleLine = recovering
              ? `Recovered link to existing T3 thread **${shellThread.title}**.`
              : `Linked existing T3 thread **${shellThread.title}**.`;
            yield* ensureLinkedBridgeAndPin({
              discordThreadId: existingLink.discordThreadId,
              titleLine,
              ...(recovering
                ? {
                    extraLines: [
                      "Previous link attempt did not finish (bridge/pin); setup is complete now.",
                    ],
                  }
                : {}),
            });
            const jump = discordChannelUrl(existingLink.guildId, existingLink.discordThreadId);
            const webLink = t3WebThreadUrl(botConfig.webUiBaseUrl, t3ThreadId);
            const content = recovering
              ? [
                  `Recovered link for **${shellThread.title}** → ${jump}`,
                  "Bridge + thread-info pin re-attached. Mention `@Omegent` to continue.",
                  webLink === null ? null : `Open in Omegent: ${webLink}`,
                ]
                  .filter((line): line is string => line !== null)
                  .join("\n")
              : [
                  `T3 thread **${shellThread.title}** is already linked here: ${jump}`,
                  webLink === null ? null : `Open in Omegent: ${webLink}`,
                ]
                  .filter((line): line is string => line !== null)
                  .join("\n");
            yield* Effect.logInfo(
              recovering
                ? "Recovered incomplete Discord↔T3 link"
                : "Pointed at existing Discord↔T3 link",
              {
                t3ThreadId,
                discordThreadId: existingLink.discordThreadId,
                replyChannelId: input.replyChannelId,
                recovering,
              },
            );
            return yield* postReply(content);
          }

          // Prefer binding to the project of the T3 thread; when the channel has a topic,
          // require it to resolve to the same project so the Discord home is correct.
          const shortName = parseTopicShortName(input.topic);
          if (shortName !== null) {
            const resolved = yield* resolveProjectFromTopic(input.topic).pipe(Effect.result);
            if (Result.isFailure(resolved)) {
              return yield* postReply(String(resolved.failure));
            }
            if (resolved.success.project.id !== shellThread.projectId) {
              return yield* postReply(
                [
                  `That T3 thread belongs to a different project than this channel.`,
                  `Thread project id: \`${shellThread.projectId}\``,
                  `Channel project (\`${resolved.success.shortName}\`): \`${resolved.success.project.id}\``,
                ].join("\n"),
              );
            }
          } else if (input.existingDiscordThreadId === null) {
            // Creating a Discord thread from a bare channel requires a project topic
            // so the thread lives in the right place.
            return yield* postReply(
              "This channel is not linked to a T3 project. Set the channel topic to include `t3-<shortName>` (e.g. `t3-example-project`).",
            );
          }

          let discordThreadId = input.existingDiscordThreadId;
          if (discordThreadId === null) {
            let starterMessageId = input.replyToMessageId;
            if (starterMessageId === null) {
              const starter = yield* rest.createMessage(input.parentChannelId, {
                content: `Linking existing T3 thread **${shellThread.title}**…`,
              });
              starterMessageId = starter.id;
            }
            const discordThread = yield* openOrReuseThread(
              input.parentChannelId,
              starterMessageId,
              truncateTitle(shellThread.title),
            );
            discordThreadId = discordThread.id;
          }

          yield* links.put({
            discordThreadId,
            t3ThreadId,
            projectId: shellThread.projectId,
            channelId: input.parentChannelId,
            guildId: input.guildId,
            createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
            sentDiscordUserMessageIds: [],
          });
          yield* ensureLinkedBridgeAndPin({
            discordThreadId,
            titleLine: `Linked existing T3 thread **${shellThread.title}**.`,
          });

          const jump = discordChannelUrl(input.guildId, discordThreadId);
          const webLink = t3WebThreadUrl(botConfig.webUiBaseUrl, t3ThreadId);
          const modelLine = `${shellThread.modelSelection.instanceId}/${shellThread.modelSelection.model}`;
          const linkedContent = [
            `Linked existing T3 thread **${shellThread.title}**.`,
            `Model: \`${modelLine}\``,
            shellThread.worktreePath === null
              ? "Mode: local (no worktree)"
              : `Worktree: \`${shellThread.worktreePath}\``,
            webLink === null ? null : `Open in Omegent: ${webLink}`,
            "Mention `@Omegent` in this thread to continue the conversation.",
          ]
            .filter((line): line is string => line !== null)
            .join("\n");

          yield* Effect.logInfo("Linked Discord thread to existing T3 thread", {
            t3ThreadId,
            discordThreadId,
            parentChannelId: input.parentChannelId,
            createdNewDiscordThread: input.existingDiscordThreadId === null,
          });

          // When the reply channel is the new/linked thread, avoid a second post.
          if (input.replyChannelId === discordThreadId) {
            return linkedContent;
          }
          return yield* postReply(
            [
              `Linked **${shellThread.title}** → ${jump}`,
              webLink === null ? null : `Open in Omegent: ${webLink}`,
            ]
              .filter((line): line is string => line !== null)
              .join("\n"),
          );
        }),
      );

    const openOrReuseThread = (channelId: string, messageId: string, name: string) =>
      rest
        .createThreadFromMessage(channelId, messageId, {
          name,
          auto_archive_duration: 1440,
        })
        .pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              // Another bot (e.g. AutoThreads) may have already opened a thread.
              yield* Effect.logWarning(
                "createThreadFromMessage failed; looking up existing thread",
                {
                  error: String(error),
                  messageId,
                },
              );
              const message = yield* rest.getMessage(channelId, messageId);
              const threadId =
                message.thread && typeof message.thread === "object" && "id" in message.thread
                  ? String((message.thread as { id: string }).id)
                  : null;
              if (threadId === null) {
                return yield* Effect.fail(error);
              }
              return { id: threadId } as { id: string };
            }),
          ),
        );

    const watchedDiscordLinkRequests = new Set<string>();
    const completedDiscordLinkRequests = new Set<string>();
    const linkingDiscordThreads = new Set<string>();
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          const shell = yield* t3.shell();
          if (shell === null) {
            yield* Effect.sleep("1 second");
            return;
          }
          for (const thread of shell.threads) {
            if (watchedDiscordLinkRequests.has(thread.id)) continue;
            watchedDiscordLinkRequests.add(thread.id);
            yield* Effect.forkDetach(
              t3
                .subscribeThread(thread.id, (detail: OrchestrationThread) =>
                  Effect.gen(function* () {
                    if (
                      completedDiscordLinkRequests.has(detail.id) ||
                      linkingDiscordThreads.has(detail.id) ||
                      !detail.messages.some(
                        (message) =>
                          message.role === "user" &&
                          message.text.includes(DISCORD_LINK_REQUEST_MARKER),
                      )
                    ) {
                      return;
                    }
                    linkingDiscordThreads.add(detail.id);
                    yield* Effect.gen(function* () {
                      const currentShell = yield* t3.shell();
                      if (currentShell === null) return;
                      const target = currentShell.threads.find(
                        (candidate) => candidate.id === detail.id,
                      );
                      if (target === undefined) return;
                      const existingLinks = yield* links.list();
                      const worktreeLink = findDiscordLinkForT3Target({
                        links: existingLinks,
                        threads: currentShell.threads,
                        target,
                      });
                      if (worktreeLink !== undefined) {
                        if (worktreeLink.t3ThreadId !== target.id) {
                          yield* links.put({
                            ...worktreeLink,
                            t3ThreadId: target.id,
                            projectId: target.projectId,
                          });
                        }
                        yield* bridgeThreadToDiscord({
                          discordChannelId: worktreeLink.discordThreadId,
                          t3ThreadId: target.id,
                        });
                        completedDiscordLinkRequests.add(target.id);
                        yield* Effect.logInfo("Reused Discord thread for GitHub link request", {
                          t3ThreadId: target.id,
                          worktreePath: target.worktreePath,
                          discordThreadId: worktreeLink.discordThreadId,
                        });
                        return;
                      }

                      const project = currentShell.projects.find(
                        (candidate) => candidate.id === target.projectId,
                      );
                      const alias =
                        project === undefined
                          ? undefined
                          : aliases
                              .list()
                              .find(
                                (candidate) =>
                                  normalizeWorkspacePath(candidate.workspaceRoot) ===
                                  normalizeWorkspacePath(project.workspaceRoot),
                              );
                      if (!alias?.discordChannelId) {
                        yield* Effect.logWarning(
                          "GitHub requested a Discord thread but the project has no Discord channel",
                          { t3ThreadId: target.id, projectId: target.projectId },
                        );
                        return;
                      }
                      const parent = yield* rest.getChannel(alias.discordChannelId);
                      const guildId =
                        "guild_id" in parent && typeof parent.guild_id === "string"
                          ? parent.guild_id
                          : "";
                      const starter = yield* rest.createMessage(alias.discordChannelId, {
                        content: `T3 created **${target.title}** from GitHub.`,
                      });
                      const discordThread = yield* openOrReuseThread(
                        alias.discordChannelId,
                        starter.id,
                        truncateTitle(target.title),
                      );
                      yield* links.put({
                        discordThreadId: discordThread.id,
                        t3ThreadId: target.id,
                        projectId: target.projectId,
                        channelId: alias.discordChannelId,
                        guildId,
                        createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
                        sentDiscordUserMessageIds: [],
                      });
                      yield* bridgeThreadToDiscord({
                        discordChannelId: discordThread.id,
                        t3ThreadId: target.id,
                      });
                      yield* upsertThreadInfoPin({
                        discordThreadId: discordThread.id,
                        t3ThreadId: target.id,
                        botConfig,
                        modelSelection: target.modelSelection,
                        worktreePath: target.worktreePath,
                        local: target.worktreePath === null,
                        titleLine: `T3 created **${target.title}** from GitHub.`,
                      }).pipe(
                        Effect.catch((error) =>
                          Effect.logWarning("Failed to create thread info pin for GitHub link", {
                            discordThreadId: discordThread.id,
                            t3ThreadId: target.id,
                            error: String(error),
                          }),
                        ),
                      );
                      completedDiscordLinkRequests.add(target.id);
                      yield* Effect.logInfo("Created Discord thread for GitHub link request", {
                        t3ThreadId: target.id,
                        worktreePath: target.worktreePath,
                        discordThreadId: discordThread.id,
                        discordChannelId: alias.discordChannelId,
                      });
                    }).pipe(
                      Effect.ensuring(
                        Effect.sync(() => {
                          linkingDiscordThreads.delete(detail.id);
                        }),
                      ),
                    );
                  }),
                )
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logError("Discord link request watcher stopped", {
                      t3ThreadId: thread.id,
                      cause,
                    }),
                  ),
                ),
            );
          }
          yield* Effect.sleep("1 second");
        }),
      ),
    );

    // The app's managed role id, per guild. Resolved lazily and cached: it never changes
    // for a given guild, and listGuildRoles on every message would burn rate limit.
    const botRoleIdByGuild = new Map<string, string | null>();
    const resolveBotRoleId = (guildId: string) =>
      Effect.gen(function* () {
        const cached = botRoleIdByGuild.get(guildId);
        if (cached !== undefined) return cached;
        const roles = yield* rest.listGuildRoles(guildId).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning(`Could not list roles for guild ${guildId}`, { cause });
              return [] as ReadonlyArray<never>;
            }),
          ),
        );
        const roleId = botManagedRoleIdFrom(roles, botUserId);
        botRoleIdByGuild.set(guildId, roleId);
        return roleId;
      });

    const handledMessageIds = createHandledDiscordMessageTracker();

    type GatewayMessageEvent = {
      readonly id: string;
      readonly channel_id: string;
      readonly guild_id?: string | null | undefined;
      readonly type?: number | undefined;
      readonly content?: string | null | undefined;
      readonly mentions?: ReadonlyArray<{ readonly id?: string }> | null | undefined;
      readonly mention_roles?: ReadonlyArray<string> | null | undefined;
      readonly attachments?: ReadonlyArray<DiscordInboundAttachment> | null | undefined;
      readonly author?:
        | {
            readonly id?: string | undefined;
            readonly username?: string | undefined;
            readonly global_name?: string | null | undefined;
            readonly bot?: boolean | undefined;
          }
        | undefined;
      readonly member?: { readonly nick?: string | null | undefined } | undefined;
      readonly embeds?: DiscordMessageLike["embeds"];
      readonly timestamp?: string | undefined;
      readonly webhook_id?: string | undefined;
      readonly referenced_message?: DiscordMessagePayload | null | undefined;
      readonly message_reference?:
        | {
            readonly message_id?: string | null | undefined;
            readonly channel_id?: string | null | undefined;
            readonly guild_id?: string | null | undefined;
          }
        | null
        | undefined;
    };

    const handleInboundMessage = (rawEvent: GatewayMessageEvent, source: "create" | "update") =>
      Effect.gen(function* () {
        // Cheap pre-filter: never re-enter routing for a message we already claimed.
        // (CREATE and UPDATE share this tracker so edits cannot start a second turn.)
        if (handledMessageIds.has(rawEvent.id)) {
          yield* Effect.logInfo("Ignoring already-handled Discord message", {
            source,
            channelId: rawEvent.channel_id,
            messageId: rawEvent.id,
          });
          return;
        }

        const event: GatewayMessageEvent | null =
          source === "update"
            ? yield* rest.getMessage(rawEvent.channel_id, rawEvent.id).pipe(
                Effect.map(
                  (full) =>
                    ({
                      ...rawEvent,
                      ...full,
                      channel_id: rawEvent.channel_id,
                    }) as GatewayMessageEvent,
                ),
                Effect.catch((error) =>
                  Effect.logWarning("Failed to hydrate Discord message update via REST", {
                    channelId: rawEvent.channel_id,
                    messageId: rawEvent.id,
                    error: String(error),
                  }).pipe(Effect.as(null)),
                ),
              )
            : rawEvent;
        if (event === null) return;

        const mentionIds = (event.mentions ?? [])
          .map((user) => user.id)
          .filter((id): id is string => typeof id === "string");
        const mentionRoleIds = (event.mention_roles ?? []).filter(
          (id): id is string => typeof id === "string",
        );
        const guildId = event.guild_id ?? null;
        const botRoleId = guildId === null ? null : yield* resolveBotRoleId(guildId);
        const mentionsBotRole = botRoleId !== null && mentionRoleIds.includes(botRoleId);

        yield* Effect.logInfo(source === "create" ? "MESSAGE_CREATE" : "MESSAGE_UPDATE", {
          channelId: event.channel_id,
          messageId: event.id,
          guildId,
          type: event.type,
          authorId: event.author?.id ?? null,
          authorBot: event.author?.bot === true,
          contentLen: (event.content ?? "").length,
          contentPreview: (event.content ?? "").slice(0, 80),
          mentionIds,
          mentionsBot: mentionIds.includes(botUserId),
          mentionRoleIds,
          mentionsBotRole,
        });

        if (
          event.author?.bot === true ||
          event.author?.id === botUserId ||
          event.webhook_id !== undefined
        ) {
          return;
        }

        let content = event.content ?? "";
        let gatewayAttachments = (event.attachments ??
          []) as ReadonlyArray<DiscordInboundAttachment>;
        let mentioned =
          mentionsBotInEvent(
            {
              content: event.content ?? null,
              mentions: event.mentions ?? null,
            },
            botUserId,
          ) ||
          mentionsBotInContent(content, botUserId) ||
          mentionsBotRole;

        if (!mentioned && content.includes(botUserId)) {
          mentioned = true;
        }

        const unmentionedLink = mentioned
          ? null
          : yield* links.getByDiscordThreadId(event.channel_id);
        const automaticThreadMessage = !mentioned && threadTalkEnabled(unmentionedLink);
        if (!mentioned && !automaticThreadMessage) return;

        if (content.length === 0) {
          yield* Effect.logWarning(
            "Routable message has empty gateway content; fetching it via REST. Enable Message Content Intent in the Discord Developer Portal.",
            { channelId: event.channel_id, messageId: event.id },
          );
          const full = yield* rest.getMessage(event.channel_id, event.id).pipe(
            Effect.catch((error) =>
              Effect.logError("Failed to fetch message content via REST", {
                error: String(error),
              }).pipe(Effect.as(null)),
            ),
          );
          if (full !== null) {
            content = full.content ?? "";
            if (Array.isArray(full.attachments) && full.attachments.length > 0) {
              gatewayAttachments = full.attachments as ReadonlyArray<DiscordInboundAttachment>;
            }
          }
        }

        if (
          event.type !== Discord.MessageType.DEFAULT &&
          event.type !== Discord.MessageType.REPLY
        ) {
          yield* Effect.logInfo("Ignoring mentioned non-user message type", {
            type: event.type,
            messageId: event.id,
          });
          return;
        }

        const referenced = yield* resolveReferencedMessage({
          event: {
            channel_id: event.channel_id,
            guild_id: event.guild_id,
            referenced_message: event.referenced_message ?? null,
            message_reference: event.message_reference ?? null,
          },
          rest: rest as {
            readonly getMessage: (
              channelId: string,
              messageId: string,
            ) => Effect.Effect<DiscordMessagePayload, unknown>;
          },
        });
        if (referenced !== null) {
          yield* Effect.logInfo("Resolved referenced Discord message for mention", {
            messageId: event.id,
            referencedMessageId: referenced.message.id,
            referencedAuthor: referenced.message.author?.username ?? null,
            hasEmbeds: (referenced.message.embeds?.length ?? 0) > 0,
          });
        }

        const channel = yield* rest.getChannel(event.channel_id);
        const inThread = isThreadChannel(channel.type);
        if (automaticThreadMessage && !inThread) return;

        // Claim before image download / turn start. Late marking let MESSAGE_UPDATE race
        // MESSAGE_CREATE and double-run prompts (especially noticeable on short edits).
        if (!handledMessageIds.claim(event.id)) {
          yield* Effect.logInfo("Ignoring concurrent Discord message routing race", {
            source,
            channelId: event.channel_id,
            messageId: event.id,
          });
          return;
        }

        const body = mentioned ? stripBotMention(content, botUserId, botRoleId) : content.trim();
        const threadTalkCommand = mentioned ? parseThreadTalkCommand(body) : null;
        if (threadTalkCommand !== null) {
          if (!inThread) {
            yield* rest.createMessage(event.channel_id, {
              content: "Thread-talk can only be configured inside a linked Discord thread.",
              message_reference: { message_id: event.id },
            });
            return;
          }
          const link = yield* links.getByDiscordThreadId(event.channel_id);
          if (link === null) {
            yield* rest.createMessage(event.channel_id, {
              content: "This Discord thread is not linked to a T3 thread yet.",
              message_reference: { message_id: event.id },
            });
            return;
          }
          if (threadTalkCommand.kind === "set") {
            yield* links.setThreadTalkMode(
              event.channel_id,
              threadTalkCommand.enabled ? "all-messages" : null,
            );
          }
          const enabled =
            threadTalkCommand.kind === "set" ? threadTalkCommand.enabled : threadTalkEnabled(link);
          yield* rest.createMessage(event.channel_id, {
            content: enabled
              ? "Thread-talk is **on**. New human messages in this linked thread will be sent to T3 without requiring a mention."
              : "Thread-talk is **off**. Mention `@Omegent` to send a message to Omegent.",
            message_reference: { message_id: event.id },
          });
          yield* Effect.logInfo("Discord thread-talk mode resolved", {
            discordThreadId: event.channel_id,
            t3ThreadId: link.t3ThreadId,
            enabled,
            command: threadTalkCommand.kind,
            actorId: event.author?.id ?? null,
          });
          return;
        }

        if (automaticThreadMessage && unmentionedLink !== null) {
          const threadShell = yield* t3.getThreadShell(unmentionedLink.t3ThreadId);
          if (hasInterruptibleTurn(threadShell)) {
            yield* rest.createMessage(event.channel_id, {
              content:
                "Omegent is already working, so this message was not submitted. Wait for the current turn to finish, or mention `@Omegent stop`.",
              message_reference: { message_id: event.id },
            });
            return;
          }
        }

        const imageCandidates = filterDiscordImageAttachments(gatewayAttachments);
        const downloaded = yield* Effect.tryPromise({
          try: () => downloadDiscordImagesAsUploadAttachments(imageCandidates),
          catch: (cause) => new DiscordImageDownloadError({ cause }),
        }).pipe(
          Effect.catch((cause) =>
            Effect.logError("Failed to download Discord image attachments").pipe(
              Effect.andThen(Effect.logError(cause)),
              Effect.as({
                uploads: [] as ReadonlyArray<UploadChatAttachment>,
                skipped: imageCandidates.map((a) => ({
                  filename: a.filename ?? "image",
                  reason: "download failed",
                })),
              }),
            ),
          ),
        );
        if (downloaded.skipped.length > 0) {
          yield* Effect.logWarning("Skipped some Discord image attachments", {
            skipped: downloaded.skipped,
          });
        }
        const uploadAttachments = downloaded.uploads;
        const hasAnyAttachments = gatewayAttachments.length > 0;

        yield* Effect.logInfo(
          automaticThreadMessage ? "Thread-talk message received" : "Bot mention received",
          {
            channelId: event.channel_id,
            messageId: event.id,
            guildId: event.guild_id ?? null,
            messageType: event.type,
            source,
            contentPreview: content.slice(0, 120),
            discordAttachments: gatewayAttachments.length,
            imageAttachments: uploadAttachments.length,
          },
        );

        const intent = mentioned
          ? parseMentionIntent(body)
          : {
              kind: "prompt" as const,
              local: false,
              plan: false,
              prompt: body,
            };
        const flags = intent.kind === "prompt" ? intent : parseMentionFlags(body);
        const prompt =
          intent.kind === "prompt" && intent.prompt.length > 0
            ? intent.prompt
            : uploadAttachments.length > 0
              ? IMAGE_ONLY_PROMPT
              : hasAnyAttachments
                ? ATTACHMENT_ONLY_PROMPT
                : "";
        if (intent.kind === "prompt" && prompt.length === 0) {
          yield* rest.createMessage(event.channel_id, {
            content:
              content.length === 0
                ? "I saw your mention but message content is empty. Enable **Message Content Intent** for this bot in the Discord Developer Portal, then restart me."
                : "Send a prompt after mentioning me (or attach a file). Optional flags: `--model` `--provider` `--base` `--local` `--plan` `--steer` `--queue`. Mid-turn follow-ups **queue** by default (📥); delete your message to cancel, or `/omegent steernow` to inject the queue. Use `--steer` to inject immediately.",
            message_reference: { message_id: event.id },
          });
          return;
        }
        const effectivePrompt = automaticThreadMessage
          ? formatUnmentionedDiscordPrompt({
              content: prompt,
              authorId: event.author?.id ?? "unknown",
              authorName: event.author?.global_name ?? event.author?.username ?? "Unknown user",
              messageId: event.id,
            })
          : prompt;
        const flagsWithPrompt = { ...flags, prompt: effectivePrompt };

        if (inThread) {
          const topicLookup = yield* resolveProjectTopic(channel);
          const parentId =
            topicLookup.kind === "parent-unavailable"
              ? topicLookup.parentChannelId
              : (topicLookup.parentChannelId ??
                ("parent_id" in channel && typeof channel.parent_id === "string"
                  ? channel.parent_id
                  : null));
          const parentUnavailable = topicLookup.kind === "parent-unavailable";
          const topic = topicLookup.kind === "resolved" ? topicLookup.topic : null;
          const pin = parentUnavailable
            ? null
            : yield* refreshChannelInfoPin(parentId ?? event.channel_id, topic);

          if (intent.kind === "help") {
            if (parentUnavailable) {
              yield* rest.createMessage(event.channel_id, {
                content: missingProjectBindingMessage({ inThread: true, parentUnavailable: true }),
                message_reference: { message_id: event.id },
              });
              return;
            }
            if (pin === null || parseTopicShortName(topic) === null) {
              yield* rest.createMessage(event.channel_id, {
                content: missingProjectBindingMessage({
                  inThread: true,
                  parentUnavailable: false,
                }),
                message_reference: { message_id: event.id },
              });
              return;
            }

            yield* rest.createMessage(event.channel_id, {
              content: `Channel info: ${discordMessageUrl(event.guild_id, pin.channelId, pin.messageId)}`,
              message_reference: { message_id: event.id },
            });
            return;
          }

          if (intent.kind === "link-thread") {
            if (parentUnavailable && parseTopicShortName(topic) === null) {
              yield* rest.createMessage(event.channel_id, {
                content: missingProjectBindingMessage({ inThread: true, parentUnavailable: true }),
                message_reference: { message_id: event.id },
              });
              return;
            }
            yield* linkExistingT3Thread({
              t3ThreadId: intent.t3ThreadId,
              replyChannelId: event.channel_id,
              replyToMessageId: event.id,
              guildId: event.guild_id ?? "",
              topic,
              existingDiscordThreadId: event.channel_id,
              parentChannelId: parentId ?? event.channel_id,
            }).pipe(Effect.catch((error) => reportError(event.channel_id, error)));
            return;
          }

          if (intent.kind === "interrupt") {
            const existing = yield* links.getByDiscordThreadId(event.channel_id);
            if (existing === null) {
              yield* rest.createMessage(event.channel_id, {
                content:
                  "This Discord thread is not linked to a T3 thread, so there is nothing to stop.",
                message_reference: { message_id: event.id },
              });
              return;
            }

            const threadShell = yield* t3.getThreadShell(existing.t3ThreadId);
            if (!hasInterruptibleTurn(threadShell)) {
              yield* rest.createMessage(event.channel_id, {
                content: "There is no active turn to stop right now.",
                message_reference: { message_id: event.id },
              });
              return;
            }

            yield* t3.interrupt(existing.t3ThreadId);
            yield* rest.createMessage(event.channel_id, {
              content: "Stopping the current turn.",
              message_reference: { message_id: event.id },
            });
            return;
          }

          if (intent.kind === "refresh-indicators") {
            const existing = yield* links.getByDiscordThreadId(event.channel_id);
            if (existing === null) {
              yield* rest.createMessage(event.channel_id, {
                content:
                  "This Discord thread is not linked to a T3 thread, so there are no indicators to refresh.",
                message_reference: { message_id: event.id },
              });
              return;
            }

            yield* bridgeThreadToDiscord({
              discordChannelId: event.channel_id,
              t3ThreadId: existing.t3ThreadId,
              mode: "rehydrate",
              preferred: true,
              lastActivityAt: existing.lastActivityAt,
            }).pipe(Effect.catch((error) => reportError(event.channel_id, error)));

            const live = yield* bridgeHub.getLive(event.channel_id, existing.t3ThreadId);
            if (live === null) {
              yield* rest.createMessage(event.channel_id, {
                content: "Could not attach a live bridge for this thread. Try again in a moment.",
                message_reference: { message_id: event.id },
              });
              return;
            }

            const result = yield* live.refreshThreadIndicators();
            yield* rest.createMessage(event.channel_id, {
              content: result.ok
                ? `Refreshed thread indicators → **${result.title}**`
                : `Refresh-indicators failed: ${result.error}`,
              message_reference: { message_id: event.id },
            });
            return;
          }

          const mentionMessage = discordMessageFromEvent({ ...event, content });
          const turnInput: BridgedTurnInput = {
            discordThreadId: event.channel_id,
            channelId: parentId ?? event.channel_id,
            guildId: event.guild_id ?? "",
            prompt: effectivePrompt,
            flags: flagsWithPrompt,
            topic,
            ...(parentUnavailable ? { parentUnavailable: true } : {}),
            parentChannelId: parentId,
            mentionMessage,
            ...(referenced !== null
              ? {
                  referencedMessage: referenced.message,
                  referencedMessageUrl: referenced.url,
                }
              : {}),
            ...(gatewayAttachments.length > 0 ? { discordAttachments: gatewayAttachments } : {}),
            ...(uploadAttachments.length > 0 ? { attachments: uploadAttachments } : {}),
            ...(automaticThreadMessage ? { presentationMode: "final-only" as const } : {}),
          };
          if (automaticThreadMessage && unmentionedLink !== null) {
            const attempted = yield* turnCoordinator
              .tryWithLock(
                event.channel_id,
                Effect.gen(function* () {
                  const latest = yield* t3.getThreadShell(unmentionedLink.t3ThreadId);
                  if (hasInterruptibleTurn(latest)) return "busy" as const;
                  yield* startBridgedTurnUnlocked(turnInput);
                  yield* waitForStartedTurnToBecomeVisible(unmentionedLink.t3ThreadId);
                  return "started" as const;
                }),
              )
              .pipe(
                Effect.catch((error) =>
                  reportError(event.channel_id, error).pipe(
                    Effect.as(Option.some("failed" as const)),
                  ),
                ),
              );
            const outcome = Option.match(attempted, {
              onNone: () => "busy" as const,
              onSome: (value) => value,
            });
            if (outcome === "busy") {
              yield* rest.createMessage(event.channel_id, {
                content:
                  "Omegent is already working, so this message was not submitted. Wait for the current turn to finish, or mention `@Omegent stop`.",
                message_reference: { message_id: event.id },
              });
            }
            return;
          }

          yield* startBridgedTurn(turnInput).pipe(
            Effect.catch((error) => reportError(event.channel_id, error)),
          );
          return;
        }

        if (intent.kind === "interrupt") {
          yield* rest.createMessage(event.channel_id, {
            content: "Stop is only supported inside a linked Discord thread.",
            message_reference: { message_id: event.id },
          });
          return;
        }

        if (intent.kind === "refresh-indicators") {
          yield* rest.createMessage(event.channel_id, {
            content: "Refresh-indicators is only supported inside a linked Discord thread.",
            message_reference: { message_id: event.id },
          });
          return;
        }

        const topicLookup = yield* resolveProjectTopic(channel);
        const parentUnavailable = topicLookup.kind === "parent-unavailable";
        const topic = topicLookup.kind === "resolved" ? topicLookup.topic : null;
        const pin = parentUnavailable
          ? null
          : yield* refreshChannelInfoPin(event.channel_id, topic);
        if (intent.kind === "help") {
          if (parentUnavailable || pin === null || parseTopicShortName(topic) === null) {
            yield* rest.createMessage(event.channel_id, {
              content: missingProjectBindingMessage({
                inThread: false,
                parentUnavailable,
              }),
              message_reference: { message_id: event.id },
            });
            return;
          }

          yield* rest.createMessage(event.channel_id, {
            content: `Channel info: ${discordMessageUrl(event.guild_id, pin.channelId, pin.messageId)}`,
            message_reference: { message_id: event.id },
          });
          return;
        }

        if (intent.kind === "link-thread") {
          if (parentUnavailable && parseTopicShortName(topic) === null) {
            yield* rest.createMessage(event.channel_id, {
              content: missingProjectBindingMessage({
                inThread: false,
                parentUnavailable: true,
              }),
              message_reference: { message_id: event.id },
            });
            return;
          }
          yield* linkExistingT3Thread({
            t3ThreadId: intent.t3ThreadId,
            replyChannelId: event.channel_id,
            replyToMessageId: event.id,
            guildId: event.guild_id ?? "",
            topic,
            existingDiscordThreadId: null,
            parentChannelId: event.channel_id,
          }).pipe(Effect.catch((error) => reportError(event.channel_id, error)));
          return;
        }

        if (parentUnavailable || parseTopicShortName(topic) === null) {
          yield* rest.createMessage(event.channel_id, {
            content: missingProjectBindingMessage({
              inThread: false,
              parentUnavailable,
            }),
            message_reference: { message_id: event.id },
          });
          return;
        }

        const discordThread = yield* openOrReuseThread(
          event.channel_id,
          event.id,
          truncateTitle(prompt),
        );
        const mentionMessage = discordMessageFromEvent({ ...event, content });

        yield* startBridgedTurn({
          discordThreadId: discordThread.id,
          channelId: event.channel_id,
          guildId: event.guild_id ?? "",
          prompt,
          flags: flagsWithPrompt,
          topic,
          parentChannelId: event.channel_id,
          mentionMessage,
          ...(referenced !== null
            ? {
                referencedMessage: referenced.message,
                referencedMessageUrl: referenced.url,
              }
            : {}),
          ...(gatewayAttachments.length > 0 ? { discordAttachments: gatewayAttachments } : {}),
          ...(uploadAttachments.length > 0 ? { attachments: uploadAttachments } : {}),
        }).pipe(Effect.catch((error) => reportError(discordThread.id, error)));
      }).pipe(Effect.catchCause(Effect.logError));

    const handleMessages = gateway.handleDispatch("MESSAGE_CREATE", (event) =>
      handleInboundMessage(event as GatewayMessageEvent, "create"),
    );
    const handleMessageUpdates = gateway.handleDispatch("MESSAGE_UPDATE", (event) =>
      handleInboundMessage(event as GatewayMessageEvent, "update"),
    );
    // User deletes their parked prompt → drop it from the server queue (and badge).
    const handleMessageDeletes = gateway.handleDispatch("MESSAGE_DELETE", (event) =>
      Effect.gen(function* () {
        const messageId =
          typeof event === "object" &&
          event !== null &&
          "id" in event &&
          typeof (event as { id?: unknown }).id === "string"
            ? (event as { id: string }).id
            : null;
        if (messageId === null) return;
        const pending = queuedPrompts.forgetDiscordMessage(messageId);
        if (pending === null) return;
        yield* Effect.logInfo("Discord user deleted queued prompt; removing from server queue", {
          discordMessageId: messageId,
          t3ThreadId: pending.t3ThreadId,
          t3MessageId: pending.t3MessageId,
        });
        yield* t3
          .removeQueuedMessage({
            threadId: pending.t3ThreadId,
            messageId: pending.t3MessageId,
          })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to remove queued prompt after Discord delete", {
                t3ThreadId: pending.t3ThreadId,
                t3MessageId: pending.t3MessageId,
                error: String(error),
              }),
            ),
          );
        // Message is gone — reaction cleanup is unnecessary.
      }).pipe(Effect.catchCause(Effect.logError)),
    );

    const approvalButton = Ix.messageComponent(
      Ix.idStartsWith("t3_approve:"),
      Effect.gen(function* () {
        const data = yield* Ix.MessageComponentData;
        const parts = data.custom_id.split(":");
        const threadId = parts[1];
        const requestId = parts[2];
        if (threadId === undefined || requestId === undefined) {
          return Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "Invalid approval payload.", flags: Discord.MessageFlags.Ephemeral },
          });
        }
        yield* t3.respondToApproval(threadId as ThreadId, requestId, "accept");
        return Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Approved.", flags: Discord.MessageFlags.Ephemeral },
        });
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.succeed(
            Ix.response({
              type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: `Approval failed: ${error instanceof Error ? error.message : String(error)}`,
                flags: Discord.MessageFlags.Ephemeral,
              },
            }),
          ),
        ),
      ),
    );

    const denyButton = Ix.messageComponent(
      Ix.idStartsWith("t3_deny:"),
      Effect.gen(function* () {
        const data = yield* Ix.MessageComponentData;
        const parts = data.custom_id.split(":");
        const threadId = parts[1];
        const requestId = parts[2];
        if (threadId === undefined || requestId === undefined) {
          return Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "Invalid approval payload.", flags: Discord.MessageFlags.Ephemeral },
          });
        }
        yield* t3.respondToApproval(threadId as ThreadId, requestId, "decline");
        return Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Denied.", flags: Discord.MessageFlags.Ephemeral },
        });
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.succeed(
            Ix.response({
              type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: `Deny failed: ${error instanceof Error ? error.message : String(error)}`,
                flags: Discord.MessageFlags.Ephemeral,
              },
            }),
          ),
        ),
      ),
    );

    const stopButton = Ix.messageComponent(
      Ix.idStartsWith("t3_stop:"),
      Effect.gen(function* () {
        const data = yield* Ix.MessageComponentData;
        const threadId = data.custom_id.slice(turnStopCustomId("").length);
        if (threadId.length === 0) {
          return Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "Invalid stop payload.", flags: Discord.MessageFlags.Ephemeral },
          });
        }

        const threadShell = yield* t3.getThreadShell(threadId as ThreadId);
        if (!hasInterruptibleTurn(threadShell)) {
          return Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: "There is no active turn to stop right now.",
              flags: Discord.MessageFlags.Ephemeral,
            },
          });
        }

        yield* t3.interrupt(threadId as ThreadId);
        return Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: "Stopping the current turn.", flags: Discord.MessageFlags.Ephemeral },
        });
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.succeed(
            Ix.response({
              type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: `Stop failed: ${error instanceof Error ? error.message : String(error)}`,
                flags: Discord.MessageFlags.Ephemeral,
              },
            }),
          ),
        ),
      ),
    );

    /**
     * Blue Continue on a wake-up notice after server restart / interrupted session.
     * Removes the button and starts a bridged "Continue" turn to wake the agent.
     */
    const continueButton = Ix.messageComponent(
      Ix.idStartsWith("t3_continue:"),
      Effect.gen(function* () {
        const interaction = yield* Ix.Interaction;
        const data = yield* Ix.MessageComponentData;
        const t3ThreadId = data.custom_id.slice(turnContinueCustomId("").length);
        if (t3ThreadId.length === 0) {
          return Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: { content: "Invalid continue payload.", flags: Discord.MessageFlags.Ephemeral },
          });
        }

        const channelId = interaction.channel_id;
        if (channelId === undefined || channelId.length === 0) {
          return Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: "Continue only works inside a Discord thread.",
              flags: Discord.MessageFlags.Ephemeral,
            },
          });
        }

        const link = yield* links.getByDiscordThreadId(channelId);
        if (link === null || link.t3ThreadId !== t3ThreadId) {
          return Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: "This thread is no longer linked to that T3 session.",
              flags: Discord.MessageFlags.Ephemeral,
            },
          });
        }

        const messageContent =
          typeof interaction.message === "object" &&
          interaction.message !== null &&
          "content" in interaction.message &&
          typeof interaction.message.content === "string"
            ? interaction.message.content
            : "";

        // Ack by stripping the Continue button so it cannot be double-clicked.
        // Bridged turn starts in the background (interaction window is short).
        const user = interaction.member?.user ?? interaction.user;
        const requester: DiscordMessageLike = {
          id: interaction.id,
          content: "Continue",
          author: {
            id: user?.id,
            username: user?.username,
            displayName:
              interaction.member?.nick ?? user?.global_name ?? user?.username ?? undefined,
            bot: user?.bot,
          },
          timestamp: interaction.id,
          channelId,
        };

        const channel = yield* rest.getChannel(channelId);
        const topicLookup = yield* resolveProjectTopic(channel);
        const parentUnavailable = topicLookup.kind === "parent-unavailable";
        const parentId =
          topicLookup.kind === "parent-unavailable"
            ? topicLookup.parentChannelId
            : (topicLookup.parentChannelId ??
              ("parent_id" in channel && typeof channel.parent_id === "string"
                ? channel.parent_id
                : null));
        const topic = topicLookup.kind === "resolved" ? topicLookup.topic : null;

        yield* forkSlashBackground(
          startBridgedTurn({
            discordThreadId: channelId,
            channelId: parentId ?? channelId,
            guildId: interaction.guild_id ?? link.guildId ?? "",
            prompt: "Continue",
            flags: { local: false, plan: false, prompt: "Continue" },
            topic,
            ...(parentUnavailable ? { parentUnavailable: true } : {}),
            parentChannelId: parentId,
            mentionMessage: requester,
          }).pipe(
            Effect.tap(() =>
              Effect.logInfo("Continue button woke interrupted T3 thread", {
                channelId,
                t3ThreadId,
              }),
            ),
            Effect.catch((error) => reportError(channelId, error)),
          ),
        );

        return Ix.response({
          type: Discord.InteractionCallbackTypes.UPDATE_MESSAGE,
          data: {
            ...idleMessageFields(messageContent),
          },
        });
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.succeed(
            Ix.response({
              type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
              data: {
                content: `Continue failed: ${error instanceof Error ? error.message : String(error)}`,
                flags: Discord.MessageFlags.Ephemeral,
              },
            }),
          ),
        ),
      ),
    );

    // `/omegent` and its `/agent` alias share one handler. Discord has no native
    // aliases, so each name is a separately registered command; the cast keeps the
    // command-spec type constant across both so the single handler type-checks.
    const makeSlashCommand = (commandName: string) =>
      Ix.guild(
        { ...OMEGENT_SLASH_COMMAND, name: commandName } as typeof OMEGENT_SLASH_COMMAND,
        (ix) => {
          const optionString = (name: string): string => {
            const value = Option.getOrUndefined(HashMap.get(ix.optionsMap, name));
            return typeof value === "string" ? value : "";
          };
          const optionBoolean = (name: string): boolean => {
            // optionsMap is string-typed; read nested option objects for booleans.
            // Cast: multi-subcommand root makes typed option names `never` in dfx helpers.
            const option = Option.getOrUndefined(ix.option(name as never));
            return option !== undefined && "value" in option && option.value === true;
          };

          const interactionRequester = (
            interaction: Discord.APIInteraction,
          ): DiscordMessageLike => {
            const user = interaction.member?.user ?? interaction.user;
            return {
              id: interaction.id,
              content: null,
              author: {
                id: user?.id,
                username: user?.username,
                displayName:
                  interaction.member?.nick ?? user?.global_name ?? user?.username ?? undefined,
                bot: user?.bot,
              },
              timestamp: interaction.id, // snowflake; buildDiscordTurnPrompt only needs identity
            };
          };

          const promptSlashHandler = (forcedDelivery?: "steer" | "queue") =>
            Effect.gen(function* () {
              const interaction = yield* Ix.Interaction;
              const channelId = interaction.channel_id;
              if (channelId === undefined || channelId.length === 0) {
                return slashReply("Ask only works inside a server channel or thread.", {
                  ephemeral: true,
                });
              }

              const prompt = optionString("prompt").trim();
              if (prompt.length === 0) {
                return slashReply("Provide a non-empty `prompt`.", { ephemeral: true });
              }

              const model = optionString("model").trim();
              const provider = optionString("provider").trim();
              const base = optionString("base").trim();
              const local = optionBoolean("local");
              const plan = optionBoolean("plan");
              const steer = optionBoolean("steer");
              const queue = optionBoolean("queue");
              // Subcommand force wins; otherwise ask booleans (queue wins if both true).
              const followUpDelivery =
                forcedDelivery ??
                (queue === true
                  ? ("queue" as const)
                  : steer === true
                    ? ("steer" as const)
                    : undefined);
              const flags = {
                ...(model.length > 0 ? { model } : {}),
                ...(provider.length > 0 ? { provider } : {}),
                ...(base.length > 0 ? { base } : {}),
                local,
                plan,
                ...(followUpDelivery === undefined ? {} : { followUpDelivery }),
                prompt,
              };

              const channel = yield* rest.getChannel(channelId);
              const inThread = isThreadChannel(channel.type);
              const topicLookup = yield* resolveProjectTopic(channel);
              const parentUnavailable = topicLookup.kind === "parent-unavailable";
              const parentId =
                topicLookup.kind === "parent-unavailable"
                  ? topicLookup.parentChannelId
                  : (topicLookup.parentChannelId ??
                    (inThread && "parent_id" in channel && typeof channel.parent_id === "string"
                      ? channel.parent_id
                      : null));
              const topic = topicLookup.kind === "resolved" ? topicLookup.topic : null;

              // New work needs a topic; continue turns can recover from an existing link.
              if (parseTopicShortName(topic) === null) {
                const existingLink = inThread ? yield* links.getByDiscordThreadId(channelId) : null;
                if (existingLink === null) {
                  return slashReply(missingProjectBindingMessage({ inThread, parentUnavailable }), {
                    ephemeral: true,
                  });
                }
              }

              const requester = interactionRequester(interaction);
              const displayName =
                requester.author?.displayName ?? requester.author?.username ?? "Someone";
              const ack = formatAskSlashAck({
                displayName,
                prompt,
                plan,
                local,
                ...(followUpDelivery === undefined ? {} : { followUpDelivery }),
              });

              if (inThread) {
                // Fire-and-forget so we ack within Discord's interaction window.
                yield* Effect.logInfo(
                  "Slash /omegent ask: starting bridged turn in linked thread",
                  {
                    channelId,
                    promptPreview: prompt.slice(0, 120),
                  },
                );
                yield* forkSlashBackground(
                  startBridgedTurn({
                    discordThreadId: channelId,
                    channelId: parentId ?? channelId,
                    guildId: interaction.guild_id ?? "",
                    prompt,
                    flags,
                    topic,
                    ...(parentUnavailable ? { parentUnavailable: true } : {}),
                    parentChannelId: parentId,
                    mentionMessage: requester,
                  }).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("Slash /omegent ask: bridged turn started in linked thread", {
                        channelId,
                      }),
                    ),
                    Effect.catch((error) => reportError(channelId, error)),
                  ),
                );
                return slashReply(ack);
              }

              // New work from a project channel: seed a public starter message, open a thread.
              const starter = yield* rest.createMessage(channelId, { content: ack });
              const discordThread = yield* openOrReuseThread(
                channelId,
                starter.id,
                truncateTitle(prompt),
              );
              yield* Effect.logInfo(
                "Slash /omegent ask: starting bridged turn in new Discord thread",
                {
                  channelId,
                  discordThreadId: discordThread.id,
                  promptPreview: prompt.slice(0, 120),
                },
              );
              yield* forkSlashBackground(
                startBridgedTurn({
                  discordThreadId: discordThread.id,
                  channelId,
                  guildId: interaction.guild_id ?? "",
                  prompt,
                  flags,
                  topic,
                  parentChannelId: channelId,
                  mentionMessage: {
                    ...requester,
                    id: starter.id,
                    content: ack,
                  },
                }).pipe(
                  Effect.tap(() =>
                    Effect.logInfo(
                      "Slash /omegent ask: bridged turn started in new Discord thread",
                      {
                        channelId,
                        discordThreadId: discordThread.id,
                      },
                    ),
                  ),
                  Effect.catch((error) => reportError(discordThread.id, error)),
                ),
              );

              const jump = discordChannelUrl(interaction.guild_id, discordThread.id);
              return slashReply(`${ack}\n→ ${jump}`);
            }).pipe(
              Effect.catch((error: unknown) =>
                Effect.succeed(
                  slashReply(
                    `Ask failed: ${error instanceof Error ? error.message : String(error)}`,
                    {
                      ephemeral: true,
                    },
                  ),
                ),
              ),
            );

          return ix.subCommands({
            ask: promptSlashHandler(),
            steer: promptSlashHandler("steer"),
            queue: promptSlashHandler("queue"),

            steernow: Effect.gen(function* () {
              const interaction = yield* Ix.Interaction;
              const channelId = interaction.channel_id;
              if (channelId === undefined || channelId.length === 0) {
                return slashReply("steernow only works inside a linked Discord thread.", {
                  ephemeral: true,
                });
              }
              const channel = yield* rest.getChannel(channelId);
              if (!isThreadChannel(channel.type)) {
                return slashReply("steernow only works inside a linked Discord thread.", {
                  ephemeral: true,
                });
              }
              const link = yield* links.getByDiscordThreadId(channelId);
              if (link === null) {
                return slashReply("This thread is not linked to an Omegent session.", {
                  ephemeral: true,
                });
              }

              // Server snapshot is authoritative after restart; local registry covers
              // HTTP lag / soft-failed fetchThreadDetail so just-queued 📥 items still flush.
              const detail = yield* t3.fetchThreadDetail(link.t3ThreadId);
              const resolved = resolveSteernowMessageIds({
                serverQueued: detail?.thread.queuedMessages ?? [],
                localPending: queuedPrompts.listForThread(link.t3ThreadId),
                detailLoaded: detail !== null,
              });
              if (resolved.messageIds.length === 0) {
                return slashReply(
                  formatSteernowEmptyQueueMessage({
                    snapshotMissing: resolved.snapshotMissing,
                  }),
                  { ephemeral: true },
                );
              }

              if (resolved.source === "local") {
                yield* Effect.logInfo("steernow using local queued-prompt registry fallback", {
                  t3ThreadId: link.t3ThreadId,
                  count: resolved.messageIds.length,
                  snapshotMissing: resolved.snapshotMissing,
                });
              }

              let steered = 0;
              const failures: string[] = [];
              for (const messageId of resolved.messageIds) {
                const result = yield* t3
                  .steerQueuedMessage({
                    threadId: link.t3ThreadId,
                    messageId,
                  })
                  .pipe(Effect.result);
                if (Result.isSuccess(result)) {
                  steered += 1;
                  const pending = queuedPrompts.forgetT3Message(link.t3ThreadId, messageId);
                  if (pending !== null) {
                    yield* clearQueuedBadge(pending);
                  }
                } else {
                  failures.push(String(messageId));
                  yield* Effect.logWarning("steernow failed for queued message", {
                    t3ThreadId: link.t3ThreadId,
                    messageId,
                    error: String(result.failure),
                  });
                }
              }

              if (steered === 0) {
                return slashReply(
                  `Could not steer the queue (${failures.length} failed). Try again when the turn is running, or use \`/agent steer prompt:…\` to inject a new mid-turn prompt.`,
                  { ephemeral: true },
                );
              }
              const failNote =
                failures.length > 0 ? ` (${failures.length} could not be steered yet)` : "";
              return slashReply(`Steered ${steered} queued message(s)${failNote}.`);
            }).pipe(
              Effect.catch((error: unknown) =>
                Effect.succeed(
                  slashReply(
                    `steernow failed: ${error instanceof Error ? error.message : String(error)}`,
                    { ephemeral: true },
                  ),
                ),
              ),
            ),

            help: Effect.gen(function* () {
              const interaction = yield* Ix.Interaction;
              const channelId = interaction.channel_id;
              if (channelId === undefined || channelId.length === 0) {
                return slashReply("This command only works inside a server channel or thread.", {
                  ephemeral: true,
                });
              }

              const channel = yield* rest.getChannel(channelId);
              const inThread = isThreadChannel(channel.type);
              const topicLookup = yield* resolveProjectTopic(channel);
              if (topicLookup.kind === "parent-unavailable") {
                return slashReply(
                  missingProjectBindingMessage({ inThread, parentUnavailable: true }),
                  {
                    ephemeral: true,
                  },
                );
              }
              const parentId = topicLookup.parentChannelId;
              const topic = topicLookup.topic;
              const pinChannelId = parentId ?? channelId;
              const binding = yield* resolveHelpChannelBinding(pinChannelId, topic);
              if (binding.kind === "ok") {
                return slashReply(
                  `Channel info: ${discordMessageUrl(interaction.guild_id, binding.pin.channelId, binding.pin.messageId)}`,
                  { ephemeral: true },
                );
              }
              if (binding.kind === "no-topic") {
                return slashReply(
                  missingProjectBindingMessage({ inThread, parentUnavailable: false }),
                  { ephemeral: true },
                );
              }
              if (binding.kind === "unknown-alias") {
                return slashReply(
                  `Channel topic resolves to alias \`${binding.shortName}\`, but that alias is not in the bot aliases file (\`T3_PROJECT_ALIASES_PATH\`).`,
                  { ephemeral: true },
                );
              }
              if (binding.kind === "no-project") {
                return slashReply(
                  `Alias \`${binding.shortName}\` → \`${binding.workspaceRoot}\`, but no T3 project is registered at that path.`,
                  { ephemeral: true },
                );
              }
              return slashReply(
                `Project \`${binding.shortName}\` is linked, but the channel-info pin could not be refreshed (often: pin content exceeded Discord’s 2000-character limit). Check bot logs for details.`,
                { ephemeral: true },
              );
            }).pipe(
              Effect.catch((error: unknown) =>
                Effect.succeed(
                  slashReply(
                    `Help failed: ${error instanceof Error ? error.message : String(error)}`,
                    {
                      ephemeral: true,
                    },
                  ),
                ),
              ),
            ),

            stop: Effect.gen(function* () {
              const interaction = yield* Ix.Interaction;
              const channelId = interaction.channel_id;
              if (channelId === undefined || channelId.length === 0) {
                return slashReply("Stop only works inside a linked Discord thread.", {
                  ephemeral: true,
                });
              }

              const channel = yield* rest.getChannel(channelId);
              if (!isThreadChannel(channel.type)) {
                return slashReply("Stop is only supported inside a linked Discord thread.", {
                  ephemeral: true,
                });
              }

              const existing = yield* links.getByDiscordThreadId(channelId);
              if (existing === null) {
                return slashReply(
                  "This Discord thread is not linked to a T3 thread, so there is nothing to stop.",
                  { ephemeral: true },
                );
              }

              const threadShell = yield* t3.getThreadShell(existing.t3ThreadId);
              if (!hasInterruptibleTurn(threadShell)) {
                return slashReply("There is no active turn to stop right now.", {
                  ephemeral: true,
                });
              }

              yield* t3.interrupt(existing.t3ThreadId);
              // Public ack so the thread has a shared audit trail.
              return slashReply("Stopping the current turn.");
            }).pipe(
              Effect.catch((error: unknown) =>
                Effect.succeed(
                  slashReply(
                    `Stop failed: ${error instanceof Error ? error.message : String(error)}`,
                    {
                      ephemeral: true,
                    },
                  ),
                ),
              ),
            ),

            "thread-talk": Effect.gen(function* () {
              const interaction = yield* Ix.Interaction;
              const channelId = interaction.channel_id;
              if (channelId === undefined || channelId.length === 0) {
                return slashReply(
                  "Thread-talk can only be configured inside a linked Discord thread.",
                  {
                    ephemeral: true,
                  },
                );
              }

              // optionsMap flattens nested subcommand options; typed optionValue() is
              // fragile across dfx's subcommand inference for multi-subcommand roots.
              const actionRaw =
                Option.getOrElse(HashMap.get(ix.optionsMap, "action"), () => "") ?? "";
              if (!isThreadTalkSlashAction(actionRaw)) {
                return slashReply("Invalid thread-talk action. Use on, off, or status.", {
                  ephemeral: true,
                });
              }

              const channel = yield* rest.getChannel(channelId);
              if (!isThreadChannel(channel.type)) {
                return slashReply(
                  "Thread-talk can only be configured inside a linked Discord thread.",
                  {
                    ephemeral: true,
                  },
                );
              }

              const link = yield* links.getByDiscordThreadId(channelId);
              if (link === null) {
                return slashReply("This Discord thread is not linked to a T3 thread yet.", {
                  ephemeral: true,
                });
              }

              if (actionRaw === "on" || actionRaw === "off") {
                yield* links.setThreadTalkMode(
                  channelId,
                  actionRaw === "on" ? "all-messages" : null,
                );
              }
              const enabled =
                actionRaw === "on" || actionRaw === "off"
                  ? actionRaw === "on"
                  : threadTalkEnabled(link);

              yield* Effect.logInfo("Discord thread-talk mode resolved via slash", {
                discordThreadId: channelId,
                t3ThreadId: link.t3ThreadId,
                enabled,
                action: actionRaw,
                actorId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
              });
              return threadTalkSlashReply({ action: actionRaw, enabled });
            }).pipe(
              Effect.catch((error: unknown) =>
                Effect.succeed(
                  slashReply(
                    `Thread-talk failed: ${error instanceof Error ? error.message : String(error)}`,
                    { ephemeral: true },
                  ),
                ),
              ),
            ),

            link: Effect.gen(function* () {
              const interaction = yield* Ix.Interaction;
              const channelId = interaction.channel_id;
              if (channelId === undefined || channelId.length === 0) {
                return slashReply("Link only works inside a server channel or thread.", {
                  ephemeral: true,
                });
              }

              const ref = (
                Option.getOrElse(HashMap.get(ix.optionsMap, "ref"), () => "") ?? ""
              ).trim();
              const t3ThreadId = extractT3ThreadId(ref);
              if (t3ThreadId === null) {
                return slashReply(
                  "Could not parse a T3 thread id from `ref`. Pass a bare id or a T3 URL with `?thread=`.",
                  { ephemeral: true },
                );
              }

              const channel = yield* rest.getChannel(channelId);
              const inThread = isThreadChannel(channel.type);
              const topicLookup = yield* resolveProjectTopic(channel);
              if (topicLookup.kind === "parent-unavailable") {
                return slashReply(
                  missingProjectBindingMessage({ inThread, parentUnavailable: true }),
                  {
                    ephemeral: true,
                  },
                );
              }
              const parentId = topicLookup.parentChannelId;
              const topic = topicLookup.topic;

              const summary = yield* linkExistingT3Thread({
                t3ThreadId,
                replyChannelId: channelId,
                replyToMessageId: null,
                guildId: interaction.guild_id ?? "",
                topic,
                existingDiscordThreadId: inThread ? channelId : null,
                parentChannelId: parentId ?? channelId,
                replyViaReturn: true,
              });
              // Shared link mutations are public.
              return slashReply(summary);
            }).pipe(
              Effect.catch((error: unknown) =>
                Effect.succeed(
                  slashReply(
                    `Link failed: ${error instanceof Error ? error.message : String(error)}`,
                    {
                      ephemeral: true,
                    },
                  ),
                ),
              ),
            ),

            "refresh-indicators": Effect.gen(function* () {
              const interaction = yield* Ix.Interaction;
              const channelId = interaction.channel_id;
              if (channelId === undefined || channelId.length === 0) {
                return slashReply("Refresh-indicators only works inside a linked Discord thread.", {
                  ephemeral: true,
                });
              }

              const channel = yield* rest.getChannel(channelId);
              if (!isThreadChannel(channel.type)) {
                return slashReply(
                  "Refresh-indicators is only supported inside a linked Discord thread.",
                  { ephemeral: true },
                );
              }

              const existing = yield* links.getByDiscordThreadId(channelId);
              if (existing === null) {
                return slashReply(
                  "This Discord thread is not linked to a T3 thread, so there are no indicators to refresh.",
                  { ephemeral: true },
                );
              }

              // Bridge rehydrate + VCS/PR lookup often exceeds Discord's ~3s interaction window.
              // Return DEFERRED immediately; finish work after dfx acks, then edit the original.
              const applicationId = interaction.application_id;
              const token = interaction.token;
              yield* forkSlashBackground(
                Effect.gen(function* () {
                  // Let the deferred interaction response land before webhook edits.
                  yield* Effect.sleep("250 millis");
                  yield* bridgeThreadToDiscord({
                    discordChannelId: channelId,
                    t3ThreadId: existing.t3ThreadId,
                    mode: "rehydrate",
                    preferred: true,
                    lastActivityAt: existing.lastActivityAt,
                  });

                  const live =
                    (yield* bridgeHub.getLive(channelId, existing.t3ThreadId)) ??
                    (yield* getLiveDiscordBridge(channelId, existing.t3ThreadId));
                  const content =
                    live === null
                      ? "Could not attach a live bridge for this thread. Try again in a moment."
                      : yield* live
                          .refreshThreadIndicators()
                          .pipe(
                            Effect.map((result) =>
                              result.ok
                                ? `Refreshed thread indicators → **${result.title}**`
                                : `Refresh-indicators failed: ${result.error}`,
                            ),
                          );

                  yield* rest
                    .updateOriginalWebhookMessage(applicationId, token, {
                      payload: { content },
                    })
                    .pipe(
                      Effect.catch((error) =>
                        Effect.logWarning("Failed to edit deferred refresh-indicators response", {
                          channelId,
                          error: String(error),
                        }),
                      ),
                    );
                }).pipe(
                  Effect.catchCause((cause) =>
                    rest
                      .updateOriginalWebhookMessage(applicationId, token, {
                        payload: {
                          content: `Refresh-indicators failed: ${formatAlertCause(cause, 300)}`,
                        },
                      })
                      .pipe(Effect.ignore),
                  ),
                ),
              );

              return slashDefer({ ephemeral: true });
            }).pipe(
              Effect.catch((error: unknown) =>
                Effect.succeed(
                  slashReply(
                    `Refresh-indicators failed: ${error instanceof Error ? error.message : String(error)}`,
                    { ephemeral: true },
                  ),
                ),
              ),
            ),
          });
        },
      );

    const omegentSlashCommand = makeSlashCommand(OMEGENT_SLASH_COMMAND_NAME);
    const agentSlashCommand = makeSlashCommand(OMEGENT_SLASH_COMMAND_ALIAS);

    yield* registry.register(
      Ix.builder
        .add(omegentSlashCommand)
        .add(agentSlashCommand)
        .add(approvalButton)
        .add(denyButton)
        .add(stopButton)
        .add(continueButton)
        .catchAllCause(Effect.logError) as never,
    );

    yield* Effect.logInfo("Registered Discord slash commands", {
      commands: [OMEGENT_SLASH_COMMAND_NAME, OMEGENT_SLASH_COMMAND_ALIAS],
      subcommands: OMEGENT_SLASH_COMMAND.options.map((option) => option.name),
      scope: "guild",
    });

    // Confirm gateway session is actually up (not only that the handler registered).
    yield* Effect.forkScoped(
      gateway.handleDispatch("READY", (ready) =>
        Effect.logInfo("Discord gateway READY", {
          user: ready.user?.username,
          userId: ready.user?.id,
          guilds: Array.isArray(ready.guilds) ? ready.guilds.length : null,
        }),
      ),
    );
    yield* Effect.forkScoped(handleMessages);
    yield* Effect.forkScoped(handleMessageUpdates);
    yield* Effect.forkScoped(handleMessageDeletes);
    yield* Effect.logInfo("Discord mention router ready");
    return DiscordBotRunning.of({ botUserId });
  });

export const MentionRouterLive = (botConfig: DiscordBotConfig) =>
  Layer.effect(DiscordBotRunning, make(botConfig));
