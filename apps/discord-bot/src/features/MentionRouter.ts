import { type IntegrationThreadView as OrchestrationThread } from "@t3tools/shared/integrationThreadView";
// @effect-diagnostics anyUnknownInErrorContext:off missingEffectContext:off globalDate:off globalErrorInEffectFailure:off globalErrorInEffectCatch:off outdatedApi:off globalFetchInEffect:off
import {
  MessageId,
  type ModelSelection,
  type ServerProvider,
  type ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import { readJiraBareKeyProjects } from "@t3tools/shared/jiraBareKeyProjects";
import { DISCORD_LINK_REQUEST_MARKER } from "@t3tools/shared/providerModelSelection";
import { makeKeyedDrainableWorker } from "@t3tools/shared/KeyedDrainableWorker";
import { makeInteractionBackground } from "./interactionBackground.ts";
import { Discord, DiscordConfig, DiscordREST, Ix } from "dfx";
import { DiscordGateway, InteractionsRegistry } from "dfx/gateway";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as HashMap from "effect/HashMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export interface DiscordMessageDispatch {
  readonly channelId: string;
  readonly handle: Effect.Effect<void, unknown>;
}

const DISCORD_MESSAGE_RETRY_DELAYS_MS = [250, 1_000, 3_000] as const;

function errorRecord(error: unknown): Readonly<Record<string, unknown>> | null {
  return typeof error === "object" && error !== null
    ? (error as Readonly<Record<string, unknown>>)
    : null;
}

/** Retry transport failures and retryable HTTP responses, never deleted/forbidden resources. */
export function isTransientDiscordDispatchError(error: unknown): boolean {
  const outer = errorRecord(error);
  if (outer === null) return false;
  if (outer._tag === "RatelimitedResponse") return true;

  const reason = errorRecord(outer.reason);
  if (reason?._tag === "RequestError" || reason?._tag === "TransportError") return true;

  const response = errorRecord(outer.response) ?? errorRecord(reason?.response);
  const status = response?.status;
  return (
    typeof status === "number" &&
    (status === 408 || status === 425 || status === 429 || status >= 500)
  );
}

export function retryTransientDiscordOperation<A, E, R>(
  handle: Effect.Effect<A, E, R>,
  retryDelaysMs: ReadonlyArray<number>,
  attempt = 0,
): Effect.Effect<A, E, R> {
  return handle.pipe(
    Effect.catchIf(
      (error) => isTransientDiscordDispatchError(error) && attempt < retryDelaysMs.length,
      () =>
        Effect.sleep(`${retryDelaysMs[attempt] ?? 0} millis`).pipe(
          Effect.andThen(retryTransientDiscordOperation(handle, retryDelaysMs, attempt + 1)),
        ),
    ),
  );
}

/**
 * Discord's gateway dispatches events concurrently. Serialize the complete
 * message lifecycle per channel so slower hydration for an earlier message
 * cannot let a later create, update, or delete overtake it.
 */
export const makeDiscordMessageDispatchQueue = (
  retryDelaysMs: ReadonlyArray<number> = DISCORD_MESSAGE_RETRY_DELAYS_MS,
) =>
  makeKeyedDrainableWorker<string, DiscordMessageDispatch, never, never>({
    key: (dispatch) => dispatch.channelId,
    process: (dispatch) =>
      retryTransientDiscordOperation(dispatch.handle, retryDelaysMs).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Discord message dispatch failed; continuing channel queue", {
            channelId: dispatch.channelId,
            cause,
          }),
        ),
      ),
  });

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
  MISSING_PROJECT_TOPIC_TAG_ERROR,
  missingProjectBindingMessage,
  parseMentionFlags,
  parseMentionIntent,
  parseTopicProjectBinding,
  projectTopicFromParentLookup,
  selectProjectForGithubRepository,
  topicHasProjectBinding,
  topicProjectBindingLabel,
  normalizeWorkspacePath,
  resolveDiscordFollowUpDelivery,
  shouldPostWorkingAckForContinue,
} from "../presentation/mentions.ts";
import {
  extractJiraIssueKeysFromDiscordMessage,
  jiraIssueKeysAfterExcludingSentryFalsePositives,
  jiraIssueKeysMaskedBySentryFromMessages,
} from "../presentation/jiraLinks.ts";
import { extractPullRequestUrlsFromDiscordMessage } from "../presentation/prLinks.ts";
import {
  extractSentryIssueUrlsFromDiscordMessage,
  mergeSentryIssueUrls,
} from "../presentation/sentryLinks.ts";
import { formatOpenInOmegentLink, isThreadInfoPinContent } from "../presentation/threadInfoPin.ts";
import {
  alertMessageIdFromOffer,
  existingConversationOfferFields,
  messageOffersNewThread,
  NEW_THREAD_OFFER_HOLD_MESSAGE,
  START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX,
} from "../presentation/existingThreadOffer.ts";
import {
  findUniqueExternalWorkItemThread,
  serverWorkItemsPathFromStateSqlite,
} from "../store/ServerWorkItemJoin.ts";
import {
  assignPullRequestAssignees,
  formatAssignSlashReply,
  resolveAssignGithubLogin,
} from "../presentation/prAssign.ts";
import {
  idleMessageFields,
  stripBotMention,
  truncateTitle,
  turnContinueCustomId,
  turnStopCustomId,
  workingMessageFields,
} from "../presentation/messages.ts";
import {
  COMPACT_POLL_INTERVAL_MS,
  COMPACT_WAIT_TIMEOUT_MS,
  extractLatestContextWindowStats,
  formatCompactionStatsReply,
  hasNewContextCompaction,
} from "../presentation/compactContext.ts";
import {
  EXPORT_SLASH_COMMAND,
  formatAskSlashAck,
  isThreadTalkSlashAction,
  OMEGENT_SLASH_COMMAND,
  OMEGENT_SLASH_COMMAND_ALIAS,
  OMEGENT_SLASH_COMMAND_NAME,
  slashDefer,
  slashReply,
  threadTalkSlashReply,
} from "../presentation/slashCommands.ts";
import { editOriginalInteractionWithAttachments, textFile } from "../presentation/discordFiles.ts";
import {
  EXPORT_HISTORY_CAP,
  EXPORT_MARKDOWN_NAME,
  exportHistoryTarget,
  exportInteractionContent,
  initialExportHistoryCursor,
  nextExportHistoryCursor,
  parseExportCount,
  renderThreadExport,
  type DiscordExportMessage,
  type ExportHistoryCursor,
} from "../presentation/threadExport.ts";
import {
  buildTodayRecapPrompt,
  chunkTodayRecapContent,
  extractLatestAssistantText,
  formatTodayRecapThreadTitle,
  formatTodayRecapWorking,
  TODAY_RECAP_TURN_POLL_MS,
  TODAY_RECAP_TURN_TIMEOUT_MS,
  utcDateStamp,
} from "../presentation/todayRecap.ts";
import { extractT3ThreadId } from "../presentation/t3ThreadRef.ts";
import {
  buildDiscordTurnPrompt,
  buildFirstTurnPrompt,
  looksLikeSentryContext,
  type DiscordMessageLike,
} from "../presentation/threadContext.ts";
import { classifyDiscordAgentAccess, IdentityMapStore } from "../identityMap.ts";
import { discordSourceHint } from "../t3/sourceHint.ts";
import { launchWorkspaceFields, resolveLaunchWorkspace } from "../t3/threadWorkspace.ts";
import { ProjectAliasStore } from "../projectAliases.ts";
import { type ThreadLink, ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { newMessageId } from "../t3/ids.ts";
import {
  T3_CONNECT_WAIT_REACTION_EMOJI,
  T3_STILL_CONNECTING_MESSAGE,
  T3Session,
  T3SessionError,
  UnknownDiscordModelError,
} from "../t3/T3Session.ts";
import { formatAlertCause } from "./Alerts.ts";
import { formatUnknownDiscordModelMessage } from "../presentation/channelInfoPin.ts";
import { topicDefaultModel, topicRequestsFastMode } from "../presentation/fastMode.ts";
import {
  isSentryMonitorPost,
  selectExistingSentryMonitorLink,
  SENTRY_MONITOR_PROMPT,
  sentryMonitorThreadTitle,
  sentryRepeatLinkContent,
  topicRequestsMonitor,
} from "../presentation/monitor.ts";
import { ensureChannelInfoPin } from "./ChannelInfoPin.ts";
import { makeDiscordThreadTurnCoordinator } from "./DiscordThreadTurnCoordinator.ts";
import {
  DiscordQueuedPrompts,
  QUEUED_PROMPT_REACTION_EMOJI,
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

export const THREAD_BOOTSTRAP_REACTION_EMOJI = "👀";

export function shouldShowThreadBootstrapReaction(input: {
  readonly inThread: boolean;
  readonly intentKind: ReturnType<typeof parseMentionIntent>["kind"];
  readonly hasPromptOrAttachment: boolean;
}): boolean {
  return (
    !input.inThread &&
    (input.intentKind === "prompt" || input.intentKind === "today-recap") &&
    input.hasPromptOrAttachment
  );
}

// Parent starter-message updates are not prompts, even when they still mention the bot.
// Deleting a thread emits such an update with the thread ID; only MESSAGE_CREATE may start new work.
export function shouldIgnoreParentChannelMessageUpdate(input: {
  readonly source: "create" | "update";
  readonly inThread: boolean;
}): boolean {
  return input.source === "update" && !input.inThread;
}

/** Thread id from THREAD_DELETE / CHANNEL_DELETE, when Discord included one. */
export function discordThreadIdFromDeleteEvent(event: unknown): string | null {
  if (typeof event !== "object" || event === null || !("id" in event)) return null;
  const id = event.id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

class DiscordImageDownloadError extends Schema.TaggedError<DiscordImageDownloadError>()(
  "DiscordImageDownloadError",
  { cause: Schema.Defect() },
) {}

class DiscordAttachmentStageError extends Schema.TaggedError<DiscordAttachmentStageError>()(
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
const resolveReferencedMessage = Effect.fn("MentionRouter.resolveReferencedMessage")(
  function* (input: {
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
  }) {
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
      Effect.map((message): DiscordMessageLike =>
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
  },
);

function discordChannelUrl(guildId: string | null | undefined, channelId: string): string {
  return `https://discord.com/channels/${guildId ?? "@me"}/${channelId}`;
}

function t3WebThreadUrl(webUiBaseUrl: string | undefined, threadId: string): string | null {
  if (webUiBaseUrl === undefined) return null;
  return `${webUiBaseUrl.replace(/\/$/u, "")}/?thread=${threadId}`;
}

function jiraKeysFromMessages(
  bareKeyProjects: ReadonlyArray<string>,
  ...messages: ReadonlyArray<
    DiscordMessageLike | null | undefined | { readonly content?: string | null }
  >
): ReadonlyArray<string> {
  const keys: string[] = [];
  for (const message of messages) {
    if (message === null || message === undefined) continue;
    if (isThreadInfoPinContent(message.content ?? null)) continue;
    keys.push(...extractJiraIssueKeysFromDiscordMessage(message, bareKeyProjects));
  }
  return keys;
}

function sentryUrlsFromMessages(
  ...messages: ReadonlyArray<
    DiscordMessageLike | null | undefined | { readonly content?: string | null }
  >
): ReadonlyArray<string> {
  const urls: string[] = [];
  for (const message of messages) {
    if (message === null || message === undefined) continue;
    if (isThreadInfoPinContent(message.content ?? null)) continue;
    urls.push(...extractSentryIssueUrlsFromDiscordMessage(message));
  }
  return urls;
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

// Match user mentions and only the app-managed role identified by tags.bot_id.
// Arbitrary roles the bot belongs to must not trigger work.
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
  readonly providers: ReadonlyArray<Pick<ServerProvider, "driver" | "instanceId">>;
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
  /** Original channel mention carrying 👀 until the linked thread-info pin is ready. */
  readonly pendingReadyReaction?: {
    readonly channelId: string;
    readonly messageId: string;
  };
  /** T3 thread title when it should not be the raw prompt. */
  readonly titleSeed?: string;
  /**
   * The user pressed "start a new thread here anyway" after we pointed at an
   * existing conversation. Skip that offer and create a new T3 thread.
   */
  readonly forceNewThread?: boolean;
  /**
   * Sentry monitor turn. The alert author is the Sentry bot, not a mapped
   * person. The channel topic opted in, or a mapped person pressed the button.
   */
  readonly sentryMonitor?: boolean;
};

const make = Effect.fn("MentionRouter.make")(function* (botConfig: DiscordBotConfig) {
  const gateway = yield* DiscordGateway;
  const rest = yield* DiscordREST;
  const discordConfig = yield* DiscordConfig.DiscordConfig;
  const discordBotToken = Redacted.value(discordConfig.token);
  const discordApiBaseUrl = discordConfig.rest.baseUrl;
  const t3 = yield* T3Session;
  const links = yield* ThreadLinkStore;
  const aliases = yield* ProjectAliasStore;
  const identityMap = yield* IdentityMapStore;
  const registry = yield* InteractionsRegistry;
  const bridgeHub = yield* BridgeHub;
  const turnCoordinator = yield* makeDiscordThreadTurnCoordinator;
  const queuedPrompts = yield* DiscordQueuedPrompts;

  const markDiscordPromptQueued = Effect.fn("MentionRouter.markDiscordPromptQueued")(
    function* (input: {
      readonly discordChannelId: string;
      readonly discordMessageId: string;
      readonly t3ThreadId: ThreadId;
      readonly t3MessageId: MessageId;
      readonly authorUserId: string | null;
    }) {
      queuedPrompts.remember(input);
      yield* rest
        .addMyMessageReaction(
          input.discordChannelId,
          input.discordMessageId,
          QUEUED_PROMPT_REACTION_EMOJI,
        )
        .pipe(
          (operation) => retryTransientDiscordOperation(operation, DISCORD_MESSAGE_RETRY_DELAYS_MS),
          Effect.catch((error) =>
            Effect.logWarning("Failed to add queued badge reaction", {
              discordMessageId: input.discordMessageId,
              error: String(error),
            }),
          ),
        );
    },
  );

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
  const getChannelWithRetry = Effect.fn("MentionRouter.getChannelWithRetry")(function* (
    channelId: string,
  ) {
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
   * Retries parent GET; never confuses a failed parent fetch with a missing `omegent-link-*` tag.
   */
  const resolveProjectTopic = Effect.fn("MentionRouter.resolveProjectTopic")(function* (channel: {
    readonly type?: number | undefined;
    readonly parent_id?: string | null | undefined;
    readonly topic?: string | null | undefined;
  }) {
    const inThread = isThreadChannel(channel.type);
    const parentId = inThread && typeof channel.parent_id === "string" ? channel.parent_id : null;
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

  /**
   * Park inbound work until T3 has a live shell (boot / post-restart reconnect).
   * Reacts with ⏳ on the triggering Discord message so the human sees the queue
   * instead of a "try again later" bounce.
   */
  const waitForT3ReadyForInbound = Effect.fn("MentionRouter.waitForT3ReadyForInbound")(
    function* (input: {
      readonly discordChannelId: string;
      readonly discordMessageId?: string;
      readonly reason: string;
    }) {
      const ready = yield* t3.isReady();
      if (ready) return;

      const messageId = input.discordMessageId;
      if (messageId !== undefined && messageId.length > 0) {
        yield* rest
          .addMyMessageReaction(input.discordChannelId, messageId, T3_CONNECT_WAIT_REACTION_EMOJI)
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to add T3 connect-wait reaction", {
                discordChannelId: input.discordChannelId,
                discordMessageId: messageId,
                error: String(error),
              }),
            ),
          );
      }

      yield* Effect.logInfo("Queuing Discord work until T3 is ready", {
        discordChannelId: input.discordChannelId,
        discordMessageId: messageId ?? null,
        reason: input.reason,
      });

      yield* t3.waitUntilReady().pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Timed out waiting for T3 readiness", {
            discordChannelId: input.discordChannelId,
            reason: input.reason,
            error: String(error),
          }),
        ),
      );

      if (messageId !== undefined && messageId.length > 0) {
        yield* rest
          .deleteMyMessageReaction(
            input.discordChannelId,
            messageId,
            T3_CONNECT_WAIT_REACTION_EMOJI,
          )
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to clear T3 connect-wait reaction", {
                discordChannelId: input.discordChannelId,
                discordMessageId: messageId,
                error: String(error),
              }),
            ),
          );
      }
    },
  );

  const topicBindingLabel = (topic: string | null | undefined): string | null => {
    const binding = parseTopicProjectBinding(topic);
    return binding === null ? null : topicProjectBindingLabel(binding);
  };

  const describeGithubSelection = (
    repository: { readonly owner: string; readonly repo: string },
    selected:
      | { readonly kind: "none" }
      | {
          readonly kind: "ambiguous";
          readonly projects: ReadonlyArray<{
            readonly title: string;
            readonly workspaceRoot: string;
          }>;
        },
  ) => {
    const label = `${repository.owner}/${repository.repo}`;
    if (selected.kind === "none") {
      return `No T3 project matches GitHub repository \`${label}\`. Add that repository in T3 first.`;
    }
    const listed = selected.projects
      .map((project) => `${project.title} (${project.workspaceRoot})`)
      .join(", ");
    return `More than one T3 project matches GitHub repository \`${label}\`: ${listed}.`;
  };

  const resolveProjectFromTopic = Effect.fn("MentionRouter.resolveProjectFromTopic")(function* (
    topic: string | null | undefined,
    wait: "full" | "short" | "none" = "full",
  ) {
    const binding = parseTopicProjectBinding(topic);
    if (binding === null) {
      return yield* Effect.fail(MISSING_PROJECT_TOPIC_TAG_ERROR);
    }
    if (binding.kind === "github") {
      let projects = yield* t3.listProjects();
      if (projects === null && wait !== "none") {
        const ready = yield* t3.isReady();
        if (!ready) {
          const waited = yield* t3
            .waitUntilReady(wait === "short" ? { timeoutMs: 2_500 } : {})
            .pipe(Effect.result);
          if (Result.isFailure(waited)) {
            return yield* Effect.fail(T3_STILL_CONNECTING_MESSAGE);
          }
          projects = yield* t3.listProjects();
        }
      }
      if (projects === null) {
        return yield* Effect.fail(T3_STILL_CONNECTING_MESSAGE);
      }
      const selected = selectProjectForGithubRepository(projects, binding.repository);
      if (selected.kind !== "match") {
        return yield* Effect.fail(describeGithubSelection(binding.repository, selected));
      }
      const label = topicProjectBindingLabel(binding);
      return {
        shortName: label,
        alias: { shortName: label, workspaceRoot: selected.project.workspaceRoot },
        project: selected.project,
      };
    }

    const shortName = binding.shortName;
    const alias = aliases.resolve(shortName);
    if (alias === null) {
      return yield* Effect.fail(
        `Unknown project alias '${shortName}'. Add it to the bot aliases file (T3_PROJECT_ALIASES_PATH).` as const,
      );
    }
    let project = yield* t3.findProjectByWorkspaceRoot(alias.workspaceRoot);
    if (project === null && wait !== "none") {
      const ready = yield* t3.isReady();
      if (!ready) {
        // Wait for shell fill / reconnect, then re-resolve the alias once.
        // Map the session error to a string so topic-resolution stays string-typed.
        // Slash help uses the short wait so it can answer inside Discord's window.
        const waited = yield* t3
          .waitUntilReady(wait === "short" ? { timeoutMs: 2_500 } : {})
          .pipe(Effect.result);
        if (Result.isFailure(waited)) {
          return yield* Effect.fail(T3_STILL_CONNECTING_MESSAGE);
        }
        project = yield* t3.findProjectByWorkspaceRoot(alias.workspaceRoot);
      }
    }
    if (project === null) {
      return yield* Effect.fail(
        `No T3 project registered at ${alias.workspaceRoot} (alias '${shortName}'). Add the project in T3 first.` as const,
      );
    }
    return { shortName, alias, project };
  });

  /**
   * Bare Jira keys need the channel's workspace before the turn starts.
   * A GitHub tag uses the shell already in hand. It does not wait out a
   * reconnect, so the existing-thread offer is not blocked on a full shell.
   */
  const bareKeyProjectsForTopic = Effect.fn("MentionRouter.bareKeyProjectsForTopic")(function* (
    topic: string | null | undefined,
  ) {
    const binding = parseTopicProjectBinding(topic);
    if (binding === null || binding.kind === "shortName") {
      const shortName = binding?.kind === "shortName" ? binding.shortName : null;
      const alias = shortName === null ? null : aliases.resolve(shortName);
      return alias === null ? [] : (readJiraBareKeyProjects(alias.workspaceRoot) ?? []);
    }
    const projects = yield* t3.listProjects();
    if (projects === null) return [];
    const selected = selectProjectForGithubRepository(projects, binding.repository);
    if (selected.kind !== "match") return [];
    return readJiraBareKeyProjects(selected.project.workspaceRoot) ?? [];
  });

  const refreshChannelInfoPin = Effect.fn("MentionRouter.refreshChannelInfoPin")(function* (
    channelId: string,
    topic: string | null | undefined,
  ) {
    const resolved = yield* resolveProjectFromTopic(topic, "none").pipe(Effect.result);
    if (Result.isFailure(resolved)) return null;
    const { shortName, project } = resolved.success;
    const serverConfig = yield* t3.serverConfig();
    return yield* ensureChannelInfoPin({
      channelId,
      workspaceRoot: project.workspaceRoot,
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
  });

  /** Resolve project binding for slash/mention help with specific failure reasons. */
  const resolveHelpChannelBinding = Effect.fn("MentionRouter.resolveHelpChannelBinding")(function* (
    channelId: string,
    topic: string | null | undefined,
  ) {
    const resolved = yield* resolveProjectFromTopic(topic, "short").pipe(Effect.result);
    if (Result.isFailure(resolved)) {
      const failure = String(resolved.failure);
      if (failure === T3_STILL_CONNECTING_MESSAGE) {
        return { kind: "t3-connecting" as const };
      }
      if (failure.startsWith("Unknown project alias '")) {
        return {
          kind: "unknown-alias" as const,
          shortName: failure.slice("Unknown project alias '".length).split("'")[0] ?? "",
        };
      }
      const missingProject = /^No T3 project registered at (.+) \(alias '([^']+)'\)/u.exec(failure);
      if (missingProject !== null) {
        return {
          kind: "no-project" as const,
          shortName: missingProject[2] ?? "",
          workspaceRoot: missingProject[1] ?? "",
        };
      }
      if (
        failure.startsWith("No T3 project matches") ||
        failure.startsWith("More than one T3 project")
      ) {
        return { kind: "github-unresolved" as const, message: failure };
      }
      return { kind: "no-topic" as const };
    }
    const { shortName, project } = resolved.success;
    const serverConfig = yield* t3.serverConfig();
    const pin = yield* ensureChannelInfoPin({
      channelId,
      workspaceRoot: project.workspaceRoot,
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
        workspaceRoot: project.workspaceRoot,
      };
    }
    return {
      kind: "ok" as const,
      shortName,
      pin,
    };
  });

  /**
   * Request provider context compact and wait briefly for token stats.
   * Always returns a user-facing public reply (stats or error).
   */
  const runContextCompact = Effect.fn("MentionRouter.runContextCompact")(
    function* (t3ThreadId: ThreadId) {
      const beforeDetail = yield* t3.fetchThreadDetail(t3ThreadId);
      const beforeActivities = beforeDetail?.thread.activities ?? [];
      const before = extractLatestContextWindowStats(beforeActivities);
      const beforeMarkerId =
        before?.activityId ??
        (beforeActivities.length > 0
          ? (beforeActivities[beforeActivities.length - 1]?.id ?? null)
          : null);

      yield* t3.compact(t3ThreadId);

      const startedAt = yield* Clock.currentTimeMillis;
      let after = before;
      let compacted = false;
      while ((yield* Clock.currentTimeMillis) - startedAt < COMPACT_WAIT_TIMEOUT_MS) {
        yield* Effect.sleep(`${COMPACT_POLL_INTERVAL_MS} millis`);
        const detail = yield* t3.fetchThreadDetail(t3ThreadId);
        const activities = detail?.thread.activities ?? [];
        after = extractLatestContextWindowStats(activities) ?? after;
        if (
          hasNewContextCompaction(activities, beforeMarkerId) ||
          (before !== null && after !== null && after.usedTokens < before.usedTokens)
        ) {
          compacted = true;
          break;
        }
      }

      return formatCompactionStatsReply({
        before,
        after,
        compacted,
      });
    },
    Effect.catch((error: unknown) =>
      Effect.succeed(
        formatCompactionStatsReply({
          before: null,
          after: null,
          compacted: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    ),
  );

  /**
   * For public threads created from a message, Discord uses the starter message id
   * as the thread id. Prefer parent channel + thread id; fall back to oldest thread msgs.
   */
  const loadThreadStarter = Effect.fn("MentionRouter.loadThreadStarter")(function* (input: {
    readonly discordThreadId: string;
    readonly parentChannelId: string | null;
    /** When the mention itself started the thread, use it as starter. */
    readonly mentionMessage?: DiscordMessageLike;
  }) {
    if (input.parentChannelId !== null) {
      const fromParent = yield* rest.getMessage(input.parentChannelId, input.discordThreadId).pipe(
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

  const clearBootstrapReaction = (
    pending: BridgedTurnInput["pendingReadyReaction"] | undefined,
  ) => {
    if (pending === undefined) return Effect.void;
    return rest
      .deleteMyMessageReaction(
        pending.channelId,
        pending.messageId,
        THREAD_BOOTSTRAP_REACTION_EMOJI,
      )
      .pipe(
        (operation) => retryTransientDiscordOperation(operation, DISCORD_MESSAGE_RETRY_DELAYS_MS),
        Effect.ignore,
      );
  };

  /**
   * Explicit model with no catalog match. Returns the user-facing reply, or
   * null when the model resolved (or was omitted). Does not start a turn.
   */
  const unknownModelMessage = Effect.fn("MentionRouter.unknownModelMessage")(function* (input: {
    readonly model?: string | undefined;
    readonly provider?: string | undefined;
    readonly guildId: string;
    readonly pinChannelId: string | null;
    readonly topic: string | null | undefined;
  }) {
    const requested = input.model?.trim() ?? "";
    if (requested.length === 0) return null;
    const resolved = yield* t3
      .resolveModelSelection({
        ...(input.provider === undefined || input.provider.trim().length === 0
          ? {}
          : { overrideInstanceId: input.provider }),
        overrideModel: requested,
      })
      .pipe(Effect.result);
    if (Result.isSuccess(resolved)) return null;
    if (!(resolved.failure instanceof UnknownDiscordModelError)) {
      return yield* Effect.fail(resolved.failure);
    }
    const pin =
      input.pinChannelId === null
        ? null
        : yield* refreshChannelInfoPin(input.pinChannelId, input.topic);
    const channelInfoUrl =
      pin !== null && pin.messageId.length > 0
        ? discordMessageUrl(input.guildId, pin.channelId, pin.messageId)
        : null;
    return formatUnknownDiscordModelMessage({
      requestedModel: resolved.failure.requestedModel,
      channelInfoUrl,
    });
  });

  // Latest offer per Discord thread, so the button can replay that turn after a click.
  // Lost on restart; the button then rebuilds the prompt from the thread starter.
  // The offer message itself is the durable hold: until it is clicked, nothing links.
  const offeredNewThreads = yield* Ref.make(new Map<string, BridgedTurnInput>());

  const discordThreadHasPendingNewThreadOffer = Effect.fn(
    "MentionRouter.discordThreadHasPendingNewThreadOffer",
  )(function* (discordThreadId: string) {
    if ((yield* Ref.get(offeredNewThreads)).has(discordThreadId)) return true;
    const listed = yield* rest
      .listMessages(discordThreadId, { limit: 50 })
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<unknown>));
    return listed.some((message) => messageOffersNewThread(message));
  });

  const startBridgedTurnUnlocked = Effect.fn("MentionRouter.startBridgedTurnUnlocked")(function* (
    input: BridgedTurnInput,
  ) {
    // Fail-closed identity gate: empty map or unmapped requester → no agent turn.
    // Applies to @mentions, slash /ask, and automatic thread-talk continues.
    // A Sentry monitor turn is started by the channel tag, not by the Sentry bot.
    if (input.sentryMonitor !== true) {
      const access = classifyDiscordAgentAccess({
        people: identityMap.list(),
        discordId: input.mentionMessage?.author?.id ?? null,
        discordUsername: input.mentionMessage?.author?.username ?? null,
        discordDisplayName: input.mentionMessage?.author?.displayName ?? null,
      });
      if (!access.allowed) {
        yield* Effect.logWarning("Rejected Discord agent turn from unmapped identity", {
          discordThreadId: input.discordThreadId,
          authorId: input.mentionMessage?.author?.id ?? null,
          authorUsername: input.mentionMessage?.author?.username ?? null,
          reason: access.reason,
        });
        yield* rest.createMessage(input.discordThreadId, {
          content: access.userMessage,
          ...(typeof input.mentionMessage?.id === "string"
            ? { message_reference: { message_id: input.mentionMessage.id } }
            : {}),
        });
        return;
      }
    }

    // Boot/reconnect race: Discord is often READY before guest T3 has a shell.
    // Queue (wait) here instead of bouncing "try again in a few seconds".
    yield* waitForT3ReadyForInbound({
      discordChannelId: input.discordThreadId,
      ...(typeof input.mentionMessage?.id === "string"
        ? { discordMessageId: input.mentionMessage.id }
        : {}),
      reason: "startBridgedTurn",
    });

    if (input.flags.model !== undefined) {
      const unknownModel = yield* unknownModelMessage({
        model: input.flags.model,
        provider: input.flags.provider,
        guildId: input.guildId,
        pinChannelId: input.parentChannelId ?? input.channelId,
        topic: input.topic,
      });
      if (unknownModel !== null) {
        yield* clearBootstrapReaction(input.pendingReadyReaction);
        yield* rest.createMessage(input.discordThreadId, {
          content: unknownModel,
          ...(typeof input.mentionMessage?.id === "string"
            ? { message_reference: { message_id: input.mentionMessage.id } }
            : {}),
        });
        return;
      }
    }

    // Only --provider / --model count as an explicit model change. Bare mentions must
    // NOT re-apply bot defaults (codex/gpt-5.4) on continue — Grok (and others) refuse
    // mid-thread model switches with "cannot switch models after the conversation has started".
    const hasExplicitModelFlags =
      input.flags.provider !== undefined || input.flags.model !== undefined;
    const attachments = input.attachments ?? [];
    const parentUnavailable = input.parentUnavailable === true;

    const existing = yield* links.getByDiscordThreadId(input.discordThreadId);
    if (input.forceNewThread === true && existing !== null) {
      yield* Effect.logInfo("New-thread button ignored; this Discord thread is already linked", {
        discordThreadId: input.discordThreadId,
        t3ThreadId: existing.t3ThreadId,
      });
      return existing.t3ThreadId;
    }
    const topicBareKeyProjects = yield* bareKeyProjectsForTopic(input.topic);

    // A new Discord thread does not join a T3 conversation that Jira or GitHub
    // already recorded. Point at that conversation, including one that lives in
    // another channel. Nothing links and no turn starts until the button.
    if (existing === null && input.forceNewThread !== true) {
      if (yield* discordThreadHasPendingNewThreadOffer(input.discordThreadId)) {
        yield* Effect.logInfo("Holding Discord thread until the new-thread button is clicked", {
          discordThreadId: input.discordThreadId,
        });
        yield* rest.createMessage(input.discordThreadId, {
          content: NEW_THREAD_OFFER_HOLD_MESSAGE,
          ...(typeof input.mentionMessage?.id === "string"
            ? { message_reference: { message_id: input.mentionMessage.id } }
            : {}),
        });
        yield* clearBootstrapReaction(input.pendingReadyReaction);
        return;
      }

      const joinStarter = yield* loadThreadStarter({
        discordThreadId: input.discordThreadId,
        parentChannelId: input.parentChannelId,
        ...(input.mentionMessage === undefined ? {} : { mentionMessage: input.mentionMessage }),
      });
      const joinJiraKeys = jiraKeysFromMessages(
        topicBareKeyProjects,
        joinStarter,
        input.mentionMessage,
        input.referencedMessage,
        { content: input.prompt },
      );
      const joinPrUrls = prUrlsFromMessages(
        joinStarter,
        input.mentionMessage,
        input.referencedMessage,
        { content: input.prompt },
      );
      if (joinJiraKeys.length > 0 || joinPrUrls.length > 0) {
        const allLinks = yield* links.list();
        const existingThreadId = findUniqueExternalWorkItemThread({
          jiraIssueKeys: joinJiraKeys,
          prUrls: joinPrUrls,
          serverWorkItemsPath: serverWorkItemsPathFromStateSqlite(botConfig.stateSqlitePath),
        });
        if (existingThreadId !== null) {
          const existingShell = yield* t3.getThreadShell(existingThreadId);
          if (existingShell !== null) {
            const activeHome = allLinks.find(
              (link) =>
                link.status === "active" &&
                (link.sourceKind ?? "discord") === "discord" &&
                link.t3ThreadId === existingThreadId,
            );
            const discordThreadUrl =
              activeHome === undefined
                ? null
                : discordChannelUrl(activeHome.guildId, activeHome.discordThreadId);
            yield* Effect.logInfo("Pointing at an existing T3 thread instead of joining it", {
              discordThreadId: input.discordThreadId,
              t3ThreadId: existingThreadId,
              existingDiscordThreadId: activeHome?.discordThreadId ?? null,
              jiraIssueKeys: joinJiraKeys,
              prUrls: joinPrUrls,
            });
            yield* rest.createMessage(input.discordThreadId, {
              ...existingConversationOfferFields({
                title: existingShell.title,
                discordThreadUrl,
                webLink: t3WebThreadUrl(botConfig.webUiBaseUrl, existingThreadId),
                t3ThreadId: existingThreadId,
              }),
              ...(typeof input.mentionMessage?.id === "string"
                ? { message_reference: { message_id: input.mentionMessage.id } }
                : {}),
            });
            yield* Ref.update(offeredNewThreads, (map) => {
              const next = new Map(map);
              next.set(input.discordThreadId, input);
              return next;
            });
            yield* clearBootstrapReaction(input.pendingReadyReaction);
            return;
          }
        }
      }
    }

    // Topic is preferred; during Discord outages fall back to the project already on the
    // Discord↔T3 link so continue turns still work instead of "no omegent-link-<shortName> tag".
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
          const shortName = topicBindingLabel(input.topic) ?? "linked";
          return {
            shortName,
            alias: {
              shortName,
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
      return yield* Effect.fail((error ?? fromTopic.failure) as typeof fromTopic.failure | string);
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
      // Re-load thread starter so co-author trailers stay available mid-thread.
      const continueStarter = yield* loadThreadStarter({
        discordThreadId: input.discordThreadId,
        parentChannelId: input.parentChannelId,
        ...(input.mentionMessage === undefined ? {} : { mentionMessage: input.mentionMessage }),
      });
      const continueWorkItemMessages = [
        continueStarter,
        input.mentionMessage,
        input.referencedMessage,
        { content: input.prompt },
      ];
      // Re-inject durable thread Jira keys so later turns (e.g. create PR) still see them.
      // Drop Sentry short ids that were previously stored as Jira (SCANNER-313 etc.).
      // A null read means the project file could not be trusted, so stored keys stay.
      const configuredBareKeyProjects = readJiraBareKeyProjects(resolved.project.workspaceRoot);
      const bareKeyProjects = configuredBareKeyProjects ?? [];
      const turnJiraIssueKeys = jiraIssueKeysAfterExcludingSentryFalsePositives(
        existing.jiraIssueKeys,
        jiraKeysFromMessages(bareKeyProjects, ...continueWorkItemMessages),
        jiraIssueKeysMaskedBySentryFromMessages(continueWorkItemMessages, bareKeyProjects),
        configuredBareKeyProjects,
      );
      const turnSentryIssueUrls = mergeSentryIssueUrls(
        existing.sentryIssueUrls,
        sentryUrlsFromMessages(...continueWorkItemMessages),
      );
      const prompt = buildDiscordTurnPrompt({
        mentionPrompt: promptWithAttachments,
        requester: input.mentionMessage,
        starter: continueStarter,
        referencedMessage: input.referencedMessage,
        referencedMessageUrl: input.referencedMessageUrl,
        jiraIssueKeys: turnJiraIssueKeys,
        sentryIssueUrls: turnSentryIssueUrls,
        jiraBrowseBaseUrl: botConfig.jiraBrowseBaseUrl,
        guildId: input.guildId,
        discordThreadId: input.discordThreadId,
        t3ThreadId: existing.t3ThreadId,
        webUiBaseUrl: botConfig.webUiBaseUrl,
        publicWebUiBaseUrl: botConfig.publicWebUiBaseUrl,
      });
      if (stagedFiles.skipped.length > 0) {
        yield* Effect.logWarning("Skipped some Discord file attachments", {
          skipped: stagedFiles.skipped,
        });
      }
      const turnAlreadyRunning = hasInterruptibleTurn(currentThread);
      const followUpDelivery = resolveDiscordFollowUpDelivery(input.flags, input.topic);
      const liveBridge = yield* getLiveDiscordBridge(input.discordThreadId, existing.t3ThreadId);
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

      // Interactive continues post a fresh Working.. tip, including mid-turn
      // steers (live bridge adopts it: freezes the old tip, streams under the new
      // one). Parked follow-ups must not — adopting would freeze the in-flight
      // answer and the queued turn's final would replace it.
      const workingAckMessageId = shouldPostWorkingAckForContinue({
        presentationMode: input.presentationMode,
        turnAlreadyRunning,
        followUpDelivery,
      })
        ? yield* rest
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
            )
        : null;
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
            ...(topicRequestsFastMode(input.topic) ? { fastMode: true } : {}),
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
          sourceHint: discordSourceHint({
            authorId: input.mentionMessage?.author?.id,
            authorUsername: input.mentionMessage?.author?.username,
            guildId: input.guildId,
            channelId: input.channelId,
            discordThreadId: input.discordThreadId,
          }),
        })
        .pipe(
          Effect.tap(({ messageId }) =>
            Effect.gen(function* () {
              yield* links.setSentDiscordUserMessageIds(input.discordThreadId, [
                ...(existing.sentDiscordUserMessageIds ?? []),
                messageId,
                pendingDiscordUserMessageId,
              ]);
              // Feed real and optimistic user-message IDs to the live bridge before starting the turn.
              // Otherwise it can misclassify the turn as external input and echo it above the Working tip.
              const bridge =
                liveBridge ??
                (yield* getLiveDiscordBridge(input.discordThreadId, existing.t3ThreadId));
              if (bridge !== null) {
                yield* bridge.noteSentUserMessageIds([messageId, pendingDiscordUserMessageId]);
              }
            }),
          ),
        );
      // Server parks busy-thread follow-ups. Default Discord policy is **steer**
      // (inject immediately after startTurn). `--queue`, `/omegent queue`, or the
      // `omegent-queue` topic park instead (📥 until the turn ends; delete the
      // message to cancel). The bridge removes 📥 once that run starts.
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
              Effect.logWarning("Steer after startTurn failed; message may remain server-queued", {
                t3ThreadId: existing.t3ThreadId,
                messageId: startedTurn.messageId,
                error: String(error),
              }).pipe(Effect.as(false)),
            ),
          );
        // If steer raced pending turn-start (or similar), keep the Discord-side
        // registry + 📥 badge. The prompt stays parked until the turn ends, and
        // deleting the message still cancels it.
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
        incomingJiraKeys: jiraKeysFromMessages(bareKeyProjects, ...continueWorkItemMessages),
        dropJiraIssueKeys: jiraIssueKeysMaskedBySentryFromMessages(
          continueWorkItemMessages,
          bareKeyProjects,
        ),
        incomingSentryIssueUrls: sentryUrlsFromMessages(...continueWorkItemMessages),
        incomingPrUrls: prUrlsFromMessages(...continueWorkItemMessages),
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

    // For a new link, explicit --model overrides the channel topic default; fast-mode topic tags still apply.
    // Continuations retain the saved selection unless the message passes --model/--provider.
    const topicModel = input.flags.model === undefined ? topicDefaultModel(input.topic) : null;
    if (topicModel !== null) {
      const unknownModel = yield* unknownModelMessage({
        model: topicModel,
        provider: input.flags.provider,
        guildId: input.guildId,
        pinChannelId: input.parentChannelId ?? input.channelId,
        topic: input.topic,
      });
      if (unknownModel !== null) {
        yield* clearBootstrapReaction(input.pendingReadyReaction);
        yield* rest.createMessage(input.discordThreadId, {
          content: unknownModel,
          ...(typeof input.mentionMessage?.id === "string"
            ? { message_reference: { message_id: input.mentionMessage.id } }
            : {}),
        });
        return;
      }
    }
    const startupModel = input.flags.model ?? topicModel ?? undefined;
    const modelSelection = yield* t3.resolveModelSelection({
      project: resolved.project,
      ...(input.flags.provider === undefined ? {} : { overrideInstanceId: input.flags.provider }),
      ...(startupModel === undefined ? {} : { overrideModel: startupModel }),
      ...(topicRequestsFastMode(input.topic) ? { fastMode: true } : {}),
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
    const firstTurnWorkItemMessages = [
      starter,
      input.mentionMessage,
      input.referencedMessage,
      { content: input.prompt },
    ];
    const bareKeyProjects =
      readJiraBareKeyProjects(resolved.project.workspaceRoot) ?? topicBareKeyProjects;
    const firstTurnJiraIssueKeys = jiraKeysFromMessages(
      bareKeyProjects,
      ...firstTurnWorkItemMessages,
    );
    const firstTurnSentryIssueUrls = sentryUrlsFromMessages(...firstTurnWorkItemMessages);
    const firstTurnSentryMaskedJira = jiraIssueKeysMaskedBySentryFromMessages(
      firstTurnWorkItemMessages,
      bareKeyProjects,
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
      sentryIssueUrls: firstTurnSentryIssueUrls,
      jiraBrowseBaseUrl: botConfig.jiraBrowseBaseUrl,
      guildId: input.guildId,
      discordThreadId: input.discordThreadId,
    });

    const workspace = yield* resolveLaunchWorkspace({
      project: resolved.project,
      explicitLocal: input.flags.local,
      explicitBase: input.flags.base ?? botConfig.t3DefaultBaseBranch,
    });
    yield* Effect.logInfo("Creating T3 thread", {
      shortName: resolved.shortName,
      workspaceRoot: resolved.project.workspaceRoot,
      model: `${modelSelection.instanceId}/${modelSelection.model}`,
      local: workspace.local,
      baseBranch: workspace.baseBranch,
      startFromOrigin: workspace.startFromOrigin,
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
      titleSeed: input.titleSeed ?? input.prompt,
      modelSelection,
      interactionMode: input.flags.plan ? "plan" : "default",
      ...launchWorkspaceFields(workspace),
      ...(attachments.length > 0 ? { attachments } : {}),
      sourceHint: discordSourceHint({
        authorId: input.mentionMessage?.author?.id,
        authorUsername: input.mentionMessage?.author?.username,
        guildId: input.guildId,
        channelId: input.channelId,
        discordThreadId: input.discordThreadId,
      }),
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
      sentryIssueUrls: firstTurnSentryIssueUrls,
      prUrls: prUrlsFromMessages(...firstTurnWorkItemMessages),
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
      dropJiraIssueKeys: firstTurnSentryMaskedJira,
      incomingSentryIssueUrls: firstTurnSentryIssueUrls,
      incomingPrUrls: prUrlsFromMessages(...firstTurnWorkItemMessages),
      modelSelection,
      ...(workspace.baseBranch === null ? {} : { baseBranchLabel: workspace.baseBranch }),
      local: workspace.local,
      skipChannelRepoLookup: true,
    }).pipe(
      Effect.tap(() =>
        input.pendingReadyReaction === undefined
          ? Effect.void
          : rest
              .deleteMyMessageReaction(
                input.pendingReadyReaction.channelId,
                input.pendingReadyReaction.messageId,
                THREAD_BOOTSTRAP_REACTION_EMOJI,
              )
              .pipe(
                (operation) =>
                  retryTransientDiscordOperation(operation, DISCORD_MESSAGE_RETRY_DELAYS_MS),
                Effect.catch((error) =>
                  Effect.logWarning("Failed to clear Discord thread bootstrap reaction", {
                    discordMessageId: input.pendingReadyReaction?.messageId,
                    error: String(error),
                  }),
                ),
              ),
      ),
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
      ...(input.presentationMode === undefined ? {} : { presentationMode: input.presentationMode }),
    });

    // Refresh after bridge start to add any slower enrichment without blocking the
    // initial Working tip / stream subscription.
    yield* upsertThreadInfoPin({
      discordThreadId: input.discordThreadId,
      t3ThreadId: threadId,
      botConfig,
      incomingJiraKeys: firstTurnJiraIssueKeys,
      dropJiraIssueKeys: firstTurnSentryMaskedJira,
      incomingSentryIssueUrls: firstTurnSentryIssueUrls,
      incomingPrUrls: prUrlsFromMessages(...firstTurnWorkItemMessages),
      modelSelection,
      ...(workspace.baseBranch === null ? {} : { baseBranchLabel: workspace.baseBranch }),
      local: workspace.local,
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

  const reportError = (channelId: string, error: unknown) => {
    const raw = error instanceof Error ? error.message : String(error);
    const content =
      error instanceof UnknownDiscordModelError
        ? formatUnknownDiscordModelMessage({
            requestedModel: error.requestedModel,
            channelInfoUrl: null,
          })
        : raw === T3_STILL_CONNECTING_MESSAGE || /not connected|still connecting/i.test(raw)
          ? T3_STILL_CONNECTING_MESSAGE
          : `Could not start T3 turn: ${raw}`;
    return rest
      .createMessage(channelId, { content })
      .pipe(Effect.catchCause(Effect.logError), Effect.asVoid);
  };

  /**
   * dfx InteractionsRegistry runs Ix handlers with a Discord-only context — app
   * services like {@link BridgeHub} are not ambient. Provide them explicitly for
   * anything that calls `bridgeThreadToDiscord` / `getLiveDiscordBridge`.
   */
  const withBridgeHub = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provideService(BridgeHub, bridgeHub));

  /**
   * Background work from interaction handlers. dfx wraps each handler in a
   * scope that closes when the ack returns. Forking from that fiber inherits
   * the scope, so the turn's HTTP is cancelled and no T3 thread starts.
   * Captured once here, on the router fiber.
   */
  const interactionBackground = yield* makeInteractionBackground();
  const forkSlashBackground = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    interactionBackground.fork(withBridgeHub(effect));

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

        const ensureLinkedBridgeAndPin = Effect.fn("MentionRouter.ensureLinkedBridgeAndPin")(
          function* (args: {
            readonly discordThreadId: string;
            readonly titleLine: string;
            readonly extraLines?: ReadonlyArray<string>;
          }) {
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
          },
        );

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
                webLink === null ? null : formatOpenInOmegentLink(webLink),
              ]
                .filter((line): line is string => line !== null)
                .join("\n")
            : [
                `T3 thread **${shellThread.title}** is already linked here: ${jump}`,
                webLink === null ? null : formatOpenInOmegentLink(webLink),
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
        if (parseTopicProjectBinding(input.topic) !== null) {
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
            missingProjectBindingMessage({ inThread: false, parentUnavailable: false }),
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
          webLink === null ? null : formatOpenInOmegentLink(webLink),
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
            webLink === null ? null : formatOpenInOmegentLink(webLink),
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
            yield* Effect.logWarning("createThreadFromMessage failed; looking up existing thread", {
              error: String(error),
              messageId,
            });
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

  const runTodayRecapTurn = Effect.fn("MentionRouter.runTodayRecapTurn")(function* (input: {
    readonly deliveryChannelId: string;
    readonly shortName: string;
    readonly topic: string | null | undefined;
    readonly guildId: string;
    readonly requester: DiscordMessageLike;
  }) {
    const date = utcDateStamp(DateTime.formatIso(DateTime.nowUnsafe()));
    const prompt = buildTodayRecapPrompt({
      shortName: input.shortName,
      date,
      parentChannelId: input.deliveryChannelId,
    });
    yield* Effect.logInfo("today-recap starting T3 turn", {
      shortName: input.shortName,
      deliveryChannelId: input.deliveryChannelId,
      date,
    });
    yield* waitForT3ReadyForInbound({
      discordChannelId: input.deliveryChannelId,
      reason: "today-recap",
    });
    const resolved = yield* resolveProjectFromTopic(input.topic);
    const topicModel = topicDefaultModel(input.topic);
    if (topicModel !== null) {
      const unknownModel = yield* unknownModelMessage({
        model: topicModel,
        guildId: input.guildId,
        pinChannelId: input.deliveryChannelId,
        topic: input.topic,
      });
      if (unknownModel !== null) return unknownModel;
    }
    const modelSelection = yield* t3.resolveModelSelection({
      project: resolved.project,
      ...(topicModel === null ? {} : { overrideModel: topicModel }),
      ...(topicRequestsFastMode(input.topic) ? { fastMode: true } : {}),
    });
    const workspace = yield* resolveLaunchWorkspace({
      project: resolved.project,
      explicitLocal: false,
      explicitBase: botConfig.t3DefaultBaseBranch,
    });
    const { threadId } = yield* t3.startTurnWithWorktree({
      project: resolved.project,
      prompt,
      titleSeed: formatTodayRecapThreadTitle({ shortName: input.shortName, date }),
      modelSelection,
      interactionMode: "default",
      ...launchWorkspaceFields(workspace),
      sourceHint: discordSourceHint({
        authorId: input.requester.author?.id,
        authorUsername: input.requester.author?.username,
        guildId: input.guildId,
        channelId: input.deliveryChannelId,
      }),
    });
    yield* Effect.logInfo("today-recap T3 thread started", {
      shortName: input.shortName,
      threadId,
      date,
    });
    const startedAt = yield* Clock.currentTimeMillis;
    while ((yield* Clock.currentTimeMillis) - startedAt < TODAY_RECAP_TURN_TIMEOUT_MS) {
      const detail = yield* t3.fetchThreadDetail(threadId);
      const state = detail?.thread.latestTurn?.state;
      if (state === "completed" || state === "interrupted" || state === "error") {
        const text = extractLatestAssistantText(detail?.thread.messages ?? []);
        yield* Effect.logInfo("today-recap T3 turn settled", {
          shortName: input.shortName,
          threadId,
          state,
          hasText: text !== null,
        });
        if (text !== null) return text;
        if (state === "interrupted") {
          return "today-recap stopped before a recap was produced.";
        }
        if (state === "error") {
          return "today-recap failed before a recap was produced.";
        }
        return "no change";
      }
      yield* Effect.sleep(`${TODAY_RECAP_TURN_POLL_MS} millis`);
    }
    yield* Effect.logWarning("today-recap timed out waiting for the recap", {
      shortName: input.shortName,
      threadId,
    });
    return "today-recap timed out waiting for the recap.";
  });

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
  const resolveBotRoleId = Effect.fn("MentionRouter.resolveBotRoleId")(function* (guildId: string) {
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

  /**
   * Same Sentry issue group already has an active Discord thread. Reply on the
   * alert with a link and the start-anyway button. No new thread and no turn.
   */
  const linkRepeatedSentryIssue = Effect.fn("MentionRouter.linkRepeatedSentryIssue")(function* (
    event: GatewayMessageEvent,
    message: DiscordMessageLike,
  ) {
    const issueUrls = extractSentryIssueUrlsFromDiscordMessage(message);
    if (issueUrls.length === 0) return false;
    const existingLink = selectExistingSentryMonitorLink(yield* links.list(), issueUrls);
    if (existingLink === null) return false;
    const shell = yield* t3.getThreadShell(existingLink.t3ThreadId);
    if (shell === null) return false;
    const discordThreadUrl = discordChannelUrl(existingLink.guildId, existingLink.discordThreadId);
    yield* Effect.logInfo("Sentry monitor linking an existing thread", {
      channelId: event.channel_id,
      messageId: event.id,
      discordThreadId: existingLink.discordThreadId,
      t3ThreadId: existingLink.t3ThreadId,
    });
    yield* rest
      .createMessage(event.channel_id, {
        ...existingConversationOfferFields({
          title: shell.title,
          discordThreadUrl,
          webLink: t3WebThreadUrl(botConfig.webUiBaseUrl, existingLink.t3ThreadId),
          t3ThreadId: existingLink.t3ThreadId,
          alertMessageId: event.id,
        }),
        content: sentryRepeatLinkContent(discordThreadUrl),
        message_reference: { message_id: event.id },
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Sentry monitor could not post the existing-thread link", {
            messageId: event.id,
            error: String(error),
          }),
        ),
      );
    return true;
  });

  /**
   * `omegent-monitor` on the channel topic: the first Sentry post for an issue
   * opens a thread and starts an investigation. A repeat of that issue links
   * the existing thread. People, other bots, and posts inside threads are left
   * alone. Returns true when this message was consumed.
   */
  const startSentryMonitor = Effect.fn("MentionRouter.startSentryMonitor")(function* (
    event: GatewayMessageEvent,
  ) {
    const message = discordMessageFromEvent(event);
    if (
      !isSentryMonitorPost({
        authorId: event.author?.id,
        authorBot: event.author?.bot === true,
        webhookId: event.webhook_id,
        botUserId,
        message,
      })
    ) {
      return false;
    }

    const channel = yield* rest.getChannel(event.channel_id).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Sentry monitor could not read the channel", {
          channelId: event.channel_id,
          messageId: event.id,
          error: String(error),
        }).pipe(Effect.as(null)),
      ),
    );
    if (channel === null || isThreadChannel(channel.type)) return false;

    const topicLookup = yield* resolveProjectTopic(channel);
    const topic = topicLookup.kind === "resolved" ? topicLookup.topic : null;
    if (!topicRequestsMonitor(topic)) return false;

    if (!handledMessageIds.claim(event.id)) return true;

    if (yield* linkRepeatedSentryIssue(event, message)) return true;

    yield* Effect.logInfo("Sentry monitor opening a thread", {
      channelId: event.channel_id,
      messageId: event.id,
      guildId: event.guild_id ?? null,
    });

    const pendingReadyReaction = {
      channelId: event.channel_id,
      messageId: event.id,
    };
    yield* rest
      .addMyMessageReaction(
        pendingReadyReaction.channelId,
        pendingReadyReaction.messageId,
        THREAD_BOOTSTRAP_REACTION_EMOJI,
      )
      .pipe(
        (operation) => retryTransientDiscordOperation(operation, DISCORD_MESSAGE_RETRY_DELAYS_MS),
        Effect.catch((error) =>
          Effect.logWarning("Failed to add Discord thread bootstrap reaction", {
            discordMessageId: event.id,
            error: String(error),
          }),
        ),
      );

    const parentUnavailable = topicLookup.kind === "parent-unavailable";
    const title = sentryMonitorThreadTitle(message);
    if (parentUnavailable || !topicHasProjectBinding(topic)) {
      const discordThread = yield* openOrReuseThread(event.channel_id, event.id, title).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Sentry monitor could not open a thread", {
            messageId: event.id,
            error: String(error),
          }).pipe(Effect.as(null)),
        ),
      );
      yield* rest.createMessage(discordThread?.id ?? event.channel_id, {
        content: missingProjectBindingMessage({
          inThread: discordThread !== null,
          parentUnavailable,
        }),
        message_reference: { message_id: event.id },
      });
      yield* clearBootstrapReaction(pendingReadyReaction);
      return true;
    }

    const discordThread = yield* openOrReuseThread(event.channel_id, event.id, title);
    yield* startBridgedTurn({
      discordThreadId: discordThread.id,
      channelId: event.channel_id,
      guildId: event.guild_id ?? "",
      prompt: SENTRY_MONITOR_PROMPT,
      flags: parseMentionFlags(""),
      topic,
      parentChannelId: event.channel_id,
      mentionMessage: message,
      pendingReadyReaction,
      titleSeed: title,
      sentryMonitor: true,
    }).pipe(Effect.catch((error) => reportError(discordThread.id, error)));
    return true;
  });

  const handleInboundMessage = Effect.fn("MentionRouter.handleInboundMessage")(function* (
    rawEvent: GatewayMessageEvent,
    source: "create" | "update",
  ) {
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
            (operation) =>
              retryTransientDiscordOperation(operation, DISCORD_MESSAGE_RETRY_DELAYS_MS),
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

    if (source === "create") {
      const monitored = yield* startSentryMonitor(event);
      if (monitored) return;
    }

    if (
      event.author?.bot === true ||
      event.author?.id === botUserId ||
      event.webhook_id !== undefined
    ) {
      return;
    }

    let content = event.content ?? "";
    let gatewayAttachments = (event.attachments ?? []) as ReadonlyArray<DiscordInboundAttachment>;
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

    const unmentionedLink = mentioned ? null : yield* links.getByDiscordThreadId(event.channel_id);
    const automaticThreadMessage = !mentioned && threadTalkEnabled(unmentionedLink);
    if (!mentioned && !automaticThreadMessage) return;

    if (content.length === 0) {
      yield* Effect.logWarning(
        "Routable message has empty gateway content; fetching it via REST. Enable Message Content Intent in the Discord Developer Portal.",
        { channelId: event.channel_id, messageId: event.id },
      );
      const full = yield* rest.getMessage(event.channel_id, event.id).pipe(
        (operation) => retryTransientDiscordOperation(operation, DISCORD_MESSAGE_RETRY_DELAYS_MS),
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

    if (event.type !== Discord.MessageType.DEFAULT && event.type !== Discord.MessageType.REPLY) {
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

    if (shouldIgnoreParentChannelMessageUpdate({ source, inThread })) {
      yield* Effect.logInfo(
        "Ignoring parent-channel Discord message update; it does not start a thread",
        {
          channelId: event.channel_id,
          messageId: event.id,
        },
      );
      return;
    }

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

    const intent = mentioned
      ? parseMentionIntent(body)
      : {
          kind: "prompt" as const,
          local: false,
          plan: false,
          prompt: body,
        };
    const flags = intent.kind === "prompt" ? intent : parseMentionFlags(body);
    const pendingReadyReaction = shouldShowThreadBootstrapReaction({
      inThread,
      intentKind: intent.kind,
      hasPromptOrAttachment:
        (intent.kind === "prompt" && intent.prompt.length > 0) ||
        intent.kind === "today-recap" ||
        gatewayAttachments.length > 0,
    })
      ? { channelId: event.channel_id, messageId: event.id }
      : undefined;
    if (pendingReadyReaction !== undefined) {
      yield* rest
        .addMyMessageReaction(
          pendingReadyReaction.channelId,
          pendingReadyReaction.messageId,
          THREAD_BOOTSTRAP_REACTION_EMOJI,
        )
        .pipe(
          (operation) => retryTransientDiscordOperation(operation, DISCORD_MESSAGE_RETRY_DELAYS_MS),
          Effect.catch((error) =>
            Effect.logWarning("Failed to add Discord thread bootstrap reaction", {
              discordMessageId: event.id,
              error: String(error),
            }),
          ),
        );
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
            : "Send a prompt after mentioning me (or attach a file). Optional flags: `--model` `<short name>` (`opus-5.5`; `claude-` and `codex-` prefixes still work) `--provider` `--base` `--local` `--plan` `--steer` `--queue`. An unknown model stops immediately and links the pinned channel info. Mid-turn follow-ups **steer** into the active turn. Use `--queue` to park until it finishes (📥; delete your message to cancel). A channel topic `omegent-queue` parks every follow-up; `--steer` still injects.",
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
        if (pin === null || !topicHasProjectBinding(topic)) {
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

      if (intent.kind === "today-recap") {
        if (parentUnavailable) {
          yield* rest.createMessage(event.channel_id, {
            content: missingProjectBindingMessage({ inThread: true, parentUnavailable: true }),
            message_reference: { message_id: event.id },
          });
          return;
        }
        const shortName = topicBindingLabel(topic);
        if (shortName === null || parentId === null) {
          yield* rest.createMessage(event.channel_id, {
            content: missingProjectBindingMessage({
              inThread: true,
              parentUnavailable: false,
            }),
            message_reference: { message_id: event.id },
          });
          return;
        }
        const mentionMessage = discordMessageFromEvent({ ...event, content });
        const recap = yield* runTodayRecapTurn({
          deliveryChannelId: event.channel_id,
          shortName,
          topic,
          guildId: event.guild_id ?? "",
          requester: mentionMessage,
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(
              `today-recap failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
        const chunks = chunkTodayRecapContent(recap);
        for (const [index, chunk] of chunks.entries()) {
          yield* rest.createMessage(event.channel_id, {
            content: chunk,
            ...(index === 0 ? { message_reference: { message_id: event.id } } : {}),
          });
        }
        return;
      }

      if (intent.kind === "link-thread") {
        if (parentUnavailable && !topicHasProjectBinding(topic)) {
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

      if (intent.kind === "compact") {
        const existing = yield* links.getByDiscordThreadId(event.channel_id);
        if (existing === null) {
          yield* rest.createMessage(event.channel_id, {
            content:
              "This Discord thread is not linked to a T3 thread, so there is nothing to compact.",
            message_reference: { message_id: event.id },
          });
          return;
        }

        const content = yield* runContextCompact(existing.t3ThreadId);
        yield* rest.createMessage(event.channel_id, {
          content,
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
        });

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
              reportError(event.channel_id, error).pipe(Effect.as(Option.some("failed" as const))),
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

    if (intent.kind === "compact") {
      yield* rest.createMessage(event.channel_id, {
        content: "Compact is only supported inside a linked Discord thread.",
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
    const pin = parentUnavailable ? null : yield* refreshChannelInfoPin(event.channel_id, topic);
    if (intent.kind === "help") {
      if (parentUnavailable || pin === null || !topicHasProjectBinding(topic)) {
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

    if (intent.kind === "today-recap") {
      const shortName = topicBindingLabel(topic);
      if (parentUnavailable || shortName === null) {
        yield* rest.createMessage(event.channel_id, {
          content: missingProjectBindingMessage({
            inThread: false,
            parentUnavailable,
          }),
          message_reference: { message_id: event.id },
        });
        return;
      }
      const mentionMessage = discordMessageFromEvent({ ...event, content });
      const recap = yield* runTodayRecapTurn({
        deliveryChannelId: event.channel_id,
        shortName,
        topic,
        guildId: event.guild_id ?? "",
        requester: mentionMessage,
      }).pipe(
        Effect.catch((error) =>
          Effect.succeed(
            `today-recap failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      );
      const chunks = chunkTodayRecapContent(recap);
      for (const [index, chunk] of chunks.entries()) {
        yield* rest.createMessage(event.channel_id, {
          content: chunk,
          ...(index === 0 ? { message_reference: { message_id: event.id } } : {}),
        });
      }
      return;
    }

    if (intent.kind === "link-thread") {
      if (parentUnavailable && !topicHasProjectBinding(topic)) {
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

    if (parentUnavailable || !topicHasProjectBinding(topic)) {
      if (pendingReadyReaction !== undefined) {
        yield* rest
          .deleteMyMessageReaction(
            pendingReadyReaction.channelId,
            pendingReadyReaction.messageId,
            THREAD_BOOTSTRAP_REACTION_EMOJI,
          )
          .pipe(
            (operation) =>
              retryTransientDiscordOperation(operation, DISCORD_MESSAGE_RETRY_DELAYS_MS),
            Effect.ignore,
          );
      }
      yield* rest.createMessage(event.channel_id, {
        content: missingProjectBindingMessage({
          inThread: false,
          parentUnavailable,
        }),
        message_reference: { message_id: event.id },
      });
      return;
    }

    if (flagsWithPrompt.model !== undefined) {
      const ready = yield* t3.isReady();
      if (ready) {
        const unknownModel = yield* unknownModelMessage({
          model: flagsWithPrompt.model,
          provider: flagsWithPrompt.provider,
          guildId: event.guild_id ?? "",
          pinChannelId: event.channel_id,
          topic,
        });
        if (unknownModel !== null) {
          yield* clearBootstrapReaction(pendingReadyReaction);
          // A channel mention cannot be ephemeral. Open the thread (or reuse
          // one AutoThreads already made) and leave the channel itself quiet.
          const threadId = yield* openOrReuseThread(
            event.channel_id,
            event.id,
            truncateTitle(prompt),
          ).pipe(
            Effect.map((thread) => thread.id),
            Effect.catch((error) =>
              Effect.logWarning(
                "Could not open a thread for the unknown-model reply; posting in the channel",
                { error: String(error), messageId: event.id },
              ).pipe(Effect.as(event.channel_id)),
            ),
          );
          yield* rest.createMessage(threadId, {
            content: unknownModel,
            message_reference: { message_id: event.id },
          });
          return;
        }
      }
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
      ...(pendingReadyReaction === undefined ? {} : { pendingReadyReaction }),
    }).pipe(Effect.catch((error) => reportError(discordThread.id, error)));
  });

  const messageDispatchQueue = yield* makeDiscordMessageDispatchQueue();
  const enqueueMessageDispatch = <E, R>(
    channelId: string,
    handle: Effect.Effect<void, E, R>,
  ): Effect.Effect<void, never, R> =>
    Effect.context<R>().pipe(
      Effect.flatMap((context) =>
        messageDispatchQueue.enqueue({
          channelId,
          handle: handle.pipe(Effect.provide(context)),
        }),
      ),
    );

  const handleMessages = gateway.handleDispatch("MESSAGE_CREATE", (event) => {
    const message = event as GatewayMessageEvent;
    return enqueueMessageDispatch(message.channel_id, handleInboundMessage(message, "create"));
  });
  const handleMessageUpdates = gateway.handleDispatch("MESSAGE_UPDATE", (event) => {
    const message = event as GatewayMessageEvent;
    return enqueueMessageDispatch(message.channel_id, handleInboundMessage(message, "update"));
  });
  // User deletes their parked prompt → drop it from the server queue (and badge).
  const handleMessageDeletes = gateway.handleDispatch("MESSAGE_DELETE", (event) => {
    const deleted = event as { readonly channel_id: string; readonly id?: unknown };
    return enqueueMessageDispatch(
      deleted.channel_id,
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
  });

  // Deleting the Discord thread must not recreate it or start another T3 turn.
  // Tombstone the link and drop the live bridge. MESSAGE_UPDATE on the starter
  // is ignored separately, including when this process never stored a link.
  const forgetDeletedDiscordThread = Effect.fn("MentionRouter.forgetDeletedDiscordThread")(
    function* (event: unknown) {
      const discordThreadId = discordThreadIdFromDeleteEvent(event);
      if (discordThreadId === null) return;
      const link = yield* links.getByDiscordThreadId(discordThreadId);
      if (link === null || link.status !== "active") {
        yield* bridgeHub.drop(discordThreadId);
        return;
      }
      yield* links.tombstone(discordThreadId);
      yield* bridgeHub.drop(discordThreadId);
      yield* Effect.logInfo("Discord thread deleted; stopped the linked T3 bridge", {
        discordThreadId,
        t3ThreadId: link.t3ThreadId,
      });
    },
    Effect.catchCause(Effect.logError),
  );

  const handleThreadDeletes = gateway.handleDispatch("THREAD_DELETE", (event) =>
    forgetDeletedDiscordThread(event),
  );
  const handleChannelDeletes = gateway.handleDispatch("CHANNEL_DELETE", (event) =>
    forgetDeletedDiscordThread(event),
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
          data: {
            content: "Invalid approval payload.",
            flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
          },
        });
      }
      yield* t3.respondToApproval(threadId as ThreadId, requestId, "accept");
      return Ix.response({
        type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "Approved.",
          flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
        },
      });
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `Approval failed: ${error instanceof Error ? error.message : String(error)}`,
              flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
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
          data: {
            content: "Invalid approval payload.",
            flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
          },
        });
      }
      yield* t3.respondToApproval(threadId as ThreadId, requestId, "decline");
      return Ix.response({
        type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "Denied.",
          flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
        },
      });
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `Deny failed: ${error instanceof Error ? error.message : String(error)}`,
              flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
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
          data: {
            content: "Invalid stop payload.",
            flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
          },
        });
      }

      const threadShell = yield* t3.getThreadShell(threadId as ThreadId);
      if (!hasInterruptibleTurn(threadShell)) {
        return Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "There is no active turn to stop right now.",
            flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
          },
        });
      }

      yield* t3.interrupt(threadId as ThreadId);
      return Ix.response({
        type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
          content: "Stopping the current turn.",
          flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
        },
      });
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `Stop failed: ${error instanceof Error ? error.message : String(error)}`,
              flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
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
          data: {
            content: "Invalid continue payload.",
            flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
          },
        });
      }

      const channelId = interaction.channel_id;
      if (channelId === undefined || channelId.length === 0) {
        return Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "Continue only works inside a Discord thread.",
            flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
          },
        });
      }

      const link = yield* links.getByDiscordThreadId(channelId);
      if (link === null || link.t3ThreadId !== t3ThreadId) {
        return Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content: "This thread is no longer linked to that T3 session.",
            flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
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
          displayName: interaction.member?.nick ?? user?.global_name ?? user?.username ?? undefined,
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
              flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
            },
          }),
        ),
      ),
    ),
  );

  /**
   * The repeat offer sits on the Sentry alert in the channel. The button opens
   * a thread from that alert and runs the same investigation as the first post.
   */
  const startRepeatedSentryInvestigation = Effect.fn(
    "MentionRouter.startRepeatedSentryInvestigation",
  )(function* (input: {
    readonly channelId: string;
    readonly guildId: string;
    readonly alertMessageId: string;
    readonly channel: {
      readonly type?: number | undefined;
      readonly parent_id?: string | null | undefined;
      readonly topic?: string | null | undefined;
    };
    readonly offeredT3ThreadId: string;
  }) {
    const fetched = yield* rest.getMessage(input.channelId, input.alertMessageId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Sentry repeat button could not load the alert", {
          channelId: input.channelId,
          messageId: input.alertMessageId,
          error: String(error),
        }).pipe(Effect.as(null)),
      ),
    );
    if (fetched === null) return false;
    const author = fetched.author;
    const sentryMessage = discordMessageFromEvent({
      id: input.alertMessageId,
      content: fetched.content,
      ...(author === null || author === undefined
        ? {}
        : {
            author: {
              ...(typeof author.id === "string" ? { id: author.id } : {}),
              ...(typeof author.username === "string" ? { username: author.username } : {}),
              ...(typeof author.global_name === "string" || author.global_name === null
                ? { global_name: author.global_name }
                : {}),
              ...(author.bot === true ? { bot: true } : {}),
            },
          }),
      embeds: fetched.embeds,
      ...(typeof fetched.timestamp === "string" ? { timestamp: fetched.timestamp } : {}),
    });
    const topicLookup = yield* resolveProjectTopic(input.channel);
    const topic = topicLookup.kind === "resolved" ? topicLookup.topic : null;
    const parentUnavailable = topicLookup.kind === "parent-unavailable";
    const title = sentryMonitorThreadTitle(sentryMessage);
    const discordThread = yield* openOrReuseThread(input.channelId, input.alertMessageId, title);
    yield* forkSlashBackground(
      startBridgedTurn({
        discordThreadId: discordThread.id,
        channelId: input.channelId,
        guildId: input.guildId,
        prompt: SENTRY_MONITOR_PROMPT,
        flags: parseMentionFlags(""),
        topic,
        ...(parentUnavailable ? { parentUnavailable: true } : {}),
        parentChannelId: input.channelId,
        mentionMessage: sentryMessage,
        titleSeed: title,
        forceNewThread: true,
        sentryMonitor: true,
      }).pipe(
        Effect.tap(() =>
          Effect.logInfo("Sentry repeat button started a thread", {
            channelId: input.channelId,
            alertMessageId: input.alertMessageId,
            discordThreadId: discordThread.id,
            offeredT3ThreadId: input.offeredT3ThreadId,
          }),
        ),
        Effect.catch((error) => reportError(discordThread.id, error)),
      ),
    );
    return true;
  });

  /**
   * Explicit opt-in after we pointed at an existing conversation instead of joining it.
   * Creates a new T3 thread in this Discord thread. The channel fast-mode tag applies.
   * On a Sentry repeat offer the message is still in the channel, so the button
   * opens the thread first.
   */
  const startNewThreadButton = Ix.messageComponent(
    Ix.idStartsWith(START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX),
    Effect.gen(function* () {
      const ephemeral = (content: string) =>
        Ix.response({
          type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
          data: {
            content,
            flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
          },
        });

      const interaction = yield* Ix.Interaction;
      const data = yield* Ix.MessageComponentData;
      const offeredT3ThreadId = data.custom_id.slice(
        START_NEW_THREAD_ANYWAY_CUSTOM_ID_PREFIX.length,
      );
      if (offeredT3ThreadId.length === 0) {
        return ephemeral("Invalid new-thread payload.");
      }

      const channelId = interaction.channel_id;
      if (channelId === undefined || channelId.length === 0) {
        return ephemeral("That button only works inside a Discord thread.");
      }

      const user = interaction.member?.user ?? interaction.user;
      const access = classifyDiscordAgentAccess({
        people: identityMap.list(),
        discordId: user?.id ?? null,
        discordUsername: user?.username ?? null,
        discordDisplayName: interaction.member?.nick ?? user?.global_name ?? user?.username ?? null,
      });
      if (!access.allowed) {
        return ephemeral(access.userMessage);
      }

      const channel = yield* rest.getChannel(channelId);
      if (!isThreadChannel(channel.type)) {
        const alertMessageId = alertMessageIdFromOffer(interaction.message, data.custom_id);
        if (alertMessageId === null) {
          return ephemeral("That button only works inside a Discord thread.");
        }
        const startedTurn = yield* startRepeatedSentryInvestigation({
          channelId,
          guildId: interaction.guild_id ?? "",
          alertMessageId,
          channel,
          offeredT3ThreadId,
        });
        if (!startedTurn) {
          return ephemeral("I couldn't find the Sentry alert for this button.");
        }
        const offerContent =
          typeof interaction.message === "object" &&
          interaction.message !== null &&
          "content" in interaction.message &&
          typeof interaction.message.content === "string"
            ? interaction.message.content
            : "";
        const started = offerContent.includes("Starting a new thread here.")
          ? offerContent
          : `${offerContent}\n\nStarting a new thread here.`.trim().slice(0, 2000);
        return Ix.response({
          type: Discord.InteractionCallbackTypes.UPDATE_MESSAGE,
          data: {
            ...idleMessageFields(started),
          },
        });
      }

      const link = yield* links.getByDiscordThreadId(channelId);
      if (link !== null && link.status === "active") {
        return ephemeral("This Discord thread already has a T3 thread.");
      }

      const pending = (yield* Ref.get(offeredNewThreads)).get(channelId);
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
      const guildId = interaction.guild_id ?? pending?.guildId ?? "";

      let turnInput: BridgedTurnInput;
      if (pending !== undefined) {
        const { pendingReadyReaction: _pendingReadyReaction, ...replay } = pending;
        turnInput = { ...replay, forceNewThread: true };
      } else {
        const botRoleId = guildId.length === 0 ? null : yield* resolveBotRoleId(guildId);
        const starter = yield* loadThreadStarter({
          discordThreadId: channelId,
          parentChannelId: parentId,
        });
        const body = stripBotMention(starter?.content ?? "", botUserId, botRoleId);
        const flags = parseMentionFlags(body);
        if (flags.prompt.length === 0) {
          return ephemeral(
            "I couldn't find the original message. Mention me again in this thread.",
          );
        }
        turnInput = {
          discordThreadId: channelId,
          channelId: parentId ?? channelId,
          guildId,
          prompt: flags.prompt,
          flags,
          topic,
          ...(parentUnavailable ? { parentUnavailable: true } : {}),
          parentChannelId: parentId,
          ...(starter === null ? {} : { mentionMessage: starter }),
          forceNewThread: true,
        };
      }

      yield* Ref.update(offeredNewThreads, (map) => {
        if (!map.has(channelId)) return map;
        const next = new Map(map);
        next.delete(channelId);
        return next;
      });

      yield* forkSlashBackground(
        startBridgedTurn(turnInput).pipe(
          Effect.tap(() =>
            Effect.logInfo("Start-new-thread button created a T3 thread", {
              channelId,
              offeredT3ThreadId,
            }),
          ),
          Effect.catch((error) => reportError(channelId, error)),
        ),
      );

      const messageContent =
        typeof interaction.message === "object" &&
        interaction.message !== null &&
        "content" in interaction.message &&
        typeof interaction.message.content === "string"
          ? interaction.message.content
          : "";
      const started = messageContent.includes("Starting a new thread here.")
        ? messageContent
        : `${messageContent}\n\nStarting a new thread here.`.trim().slice(0, 2000);

      return Ix.response({
        type: Discord.InteractionCallbackTypes.UPDATE_MESSAGE,
        data: {
          ...idleMessageFields(started),
        },
      });
    }).pipe(
      Effect.catch((error: unknown) =>
        Effect.succeed(
          Ix.response({
            type: Discord.InteractionCallbackTypes.CHANNEL_MESSAGE_WITH_SOURCE,
            data: {
              content: `Could not start a new thread: ${error instanceof Error ? error.message : String(error)}`,
              flags: Discord.MessageFlags.Ephemeral | Discord.MessageFlags.SuppressEmbeds,
            },
          }),
        ),
      ),
    ),
  );

  // `/omegent` and its `/agent` alias share one handler. Discord has no native
  // aliases, so each name is a separately registered command; the cast keeps the
  // command-spec type constant across both so the single handler type-checks.
  const exportCountRaw = (optionsMap: HashMap.HashMap<string, string | undefined>) =>
    Option.getOrUndefined(HashMap.get(optionsMap, "count"));

  const respondToExport = Effect.fn("MentionRouter.respondToExport")(function* (countRaw: unknown) {
    const interaction = yield* Ix.Interaction;
    const channelId = interaction.channel_id;
    if (channelId === undefined || channelId.length === 0) {
      return slashReply("Export only works inside a server channel or thread.", {
        ephemeral: true,
      });
    }

    const parsed = parseExportCount(countRaw);
    if (parsed === null) {
      return slashReply(
        `count must be a whole number from 1 to ${EXPORT_HISTORY_CAP}. Omit it to copy the whole chat.`,
        { ephemeral: true },
      );
    }
    const target = exportHistoryTarget(parsed);

    const applicationId = interaction.application_id;
    const interactionToken = interaction.token;
    yield* forkSlashBackground(
      Effect.gen(function* () {
        // The deferred ack has to land before the original response can be edited.
        yield* Effect.sleep("250 millis");
        const listed: Array<DiscordExportMessage> = [];
        let cursor: ExportHistoryCursor | undefined = initialExportHistoryCursor(target);
        let truncated = false;
        while (cursor !== undefined) {
          const page = yield* retryTransientDiscordOperation(
            rest.listMessages(channelId, {
              limit: cursor.limit,
              ...(cursor.before === undefined ? {} : { before: cursor.before }),
            }),
            DISCORD_MESSAGE_RETRY_DELAYS_MS,
          );
          listed.push(...page);
          const oldestId = page.at(-1)?.id;
          const next = nextExportHistoryCursor({
            target,
            collected: listed.length,
            pageCount: page.length,
            pageLimit: cursor.limit,
            oldestId,
          });
          if (next === "end") {
            cursor = undefined;
          } else if (next === "maybe-truncated") {
            // A full page that lands on the cap may still be the last page.
            const probe =
              oldestId === undefined
                ? []
                : yield* retryTransientDiscordOperation(
                    rest.listMessages(channelId, { limit: 1, before: oldestId }),
                    DISCORD_MESSAGE_RETRY_DELAYS_MS,
                  );
            truncated = probe.length > 0;
            cursor = undefined;
          } else {
            cursor = next;
          }
        }
        const markdown = renderThreadExport({
          messages: listed,
          botUserId,
          truncated,
        });
        yield* Effect.tryPromise({
          try: () =>
            editOriginalInteractionWithAttachments({
              baseUrl: discordApiBaseUrl,
              botToken: discordBotToken,
              applicationId,
              interactionToken,
              content: exportInteractionContent(markdown),
              files: [textFile(EXPORT_MARKDOWN_NAME, markdown)],
            }),
          catch: (cause) => (cause instanceof Error ? cause : new Error("Export upload failed")),
        });
      }).pipe(
        Effect.catch((error: unknown) =>
          rest
            .updateOriginalWebhookMessage(applicationId, interactionToken, {
              payload: {
                content: `Export failed: ${error instanceof Error ? error.message : String(error)}`,
              },
            })
            .pipe(Effect.ignore),
        ),
      ),
    );

    return slashDefer({ ephemeral: true });
  });

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

        const interactionRequester = (interaction: Discord.APIInteraction): DiscordMessageLike => {
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

        const promptSlashHandler = Effect.fn("MentionRouter.promptSlashHandler")(
          function* (forcedDelivery: "steer" | "queue" | undefined) {
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
            if (!topicHasProjectBinding(topic)) {
              const existingLink = inThread ? yield* links.getByDiscordThreadId(channelId) : null;
              if (existingLink === null) {
                return slashReply(missingProjectBindingMessage({ inThread, parentUnavailable }), {
                  ephemeral: true,
                });
              }
            }

            if (model.length > 0) {
              const ready = yield* t3.isReady();
              if (ready) {
                const unknownModel = yield* unknownModelMessage({
                  model,
                  ...(provider.length > 0 ? { provider } : {}),
                  guildId: interaction.guild_id ?? "",
                  pinChannelId: parentId ?? channelId,
                  topic,
                });
                if (unknownModel !== null) {
                  return slashReply(unknownModel, { ephemeral: true });
                }
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
              yield* Effect.logInfo("Slash /omegent ask: starting bridged turn in linked thread", {
                channelId,
                promptPreview: prompt.slice(0, 120),
              });
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
                  Effect.logInfo("Slash /omegent ask: bridged turn started in new Discord thread", {
                    channelId,
                    discordThreadId: discordThread.id,
                  }),
                ),
                Effect.catch((error) => reportError(discordThread.id, error)),
              ),
            );

            const jump = discordChannelUrl(interaction.guild_id, discordThread.id);
            return slashReply(`${ack}\n→ ${jump}`);
          },
          Effect.catch((error: unknown) =>
            Effect.succeed(
              slashReply(`Ask failed: ${error instanceof Error ? error.message : String(error)}`, {
                ephemeral: true,
              }),
            ),
          ),
        );

        return ix.subCommands({
          ask: promptSlashHandler(undefined),
          steer: promptSlashHandler("steer"),
          queue: promptSlashHandler("queue"),

          "today-recap": Effect.gen(function* () {
            const interaction = yield* Ix.Interaction;
            const channelId = interaction.channel_id;
            if (channelId === undefined || channelId.length === 0) {
              return slashReply("today-recap only works inside a server channel or thread.", {
                ephemeral: true,
              });
            }

            const channel = yield* rest.getChannel(channelId);
            const inThread = isThreadChannel(channel.type);
            const topicLookup = yield* resolveProjectTopic(channel);
            const parentUnavailable = topicLookup.kind === "parent-unavailable";
            const topic = topicLookup.kind === "resolved" ? topicLookup.topic : null;
            const shortName = topicBindingLabel(topic);
            if (parentUnavailable || shortName === null) {
              return slashReply(missingProjectBindingMessage({ inThread, parentUnavailable }), {
                ephemeral: true,
              });
            }

            const requester = interactionRequester(interaction);
            const access = classifyDiscordAgentAccess({
              people: identityMap.list(),
              discordId: requester.author?.id ?? null,
              discordUsername: requester.author?.username ?? null,
              discordDisplayName: requester.author?.displayName ?? null,
            });
            if (!access.allowed) {
              return slashReply(access.userMessage, { ephemeral: true });
            }

            const applicationId = interaction.application_id;
            const token = interaction.token;
            yield* forkSlashBackground(
              Effect.gen(function* () {
                yield* Effect.sleep("250 millis");
                const date = utcDateStamp(DateTime.formatIso(DateTime.nowUnsafe()));
                yield* rest
                  .updateOriginalWebhookMessage(applicationId, token, {
                    payload: {
                      content: formatTodayRecapWorking({ shortName, date }),
                    },
                  })
                  .pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("today-recap working status failed", {
                        shortName,
                        error: String(error),
                      }),
                    ),
                  );
                const recap = yield* runTodayRecapTurn({
                  deliveryChannelId: channelId,
                  shortName,
                  topic,
                  guildId: interaction.guild_id ?? "",
                  requester,
                });
                const chunks = chunkTodayRecapContent(recap);
                yield* rest.updateOriginalWebhookMessage(applicationId, token, {
                  payload: { content: chunks[0] ?? "no change" },
                });
                for (const extra of chunks.slice(1)) {
                  yield* rest.createMessage(channelId, { content: extra });
                }
              }).pipe(
                Effect.catch((error: unknown) =>
                  rest
                    .updateOriginalWebhookMessage(applicationId, token, {
                      payload: {
                        content: `today-recap failed: ${error instanceof Error ? error.message : String(error)}`,
                      },
                    })
                    .pipe(Effect.ignore),
                ),
              ),
            );

            return slashDefer();
          }).pipe(
            Effect.catch((error: unknown) =>
              Effect.succeed(
                slashReply(
                  `today-recap failed: ${error instanceof Error ? error.message : String(error)}`,
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
            if (binding.kind === "t3-connecting") {
              return slashReply(T3_STILL_CONNECTING_MESSAGE, { ephemeral: true });
            }
            if (binding.kind === "no-project") {
              return slashReply(
                `Alias \`${binding.shortName}\` → \`${binding.workspaceRoot}\`, but no T3 project is registered at that path.`,
                { ephemeral: true },
              );
            }
            if (binding.kind === "github-unresolved") {
              return slashReply(binding.message, { ephemeral: true });
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

          compact: Effect.gen(function* () {
            const interaction = yield* Ix.Interaction;
            const channelId = interaction.channel_id;
            if (channelId === undefined || channelId.length === 0) {
              return slashReply("Compact only works inside a linked Discord thread.", {
                ephemeral: true,
              });
            }

            const channel = yield* rest.getChannel(channelId);
            if (!isThreadChannel(channel.type)) {
              return slashReply("Compact is only supported inside a linked Discord thread.", {
                ephemeral: true,
              });
            }

            const existing = yield* links.getByDiscordThreadId(channelId);
            if (existing === null) {
              return slashReply(
                "This Discord thread is not linked to a T3 thread, so there is nothing to compact.",
                { ephemeral: true },
              );
            }

            // Compact can take longer than Discord's ~3s interaction window.
            // Public deferred reply → edit with compaction stats for the channel.
            const applicationId = interaction.application_id;
            const token = interaction.token;
            yield* forkSlashBackground(
              Effect.gen(function* () {
                yield* Effect.sleep("250 millis");
                const content = yield* runContextCompact(existing.t3ThreadId);
                yield* rest
                  .updateOriginalWebhookMessage(applicationId, token, {
                    payload: { content },
                  })
                  .pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("Failed to edit deferred compact response", {
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
                        content: `Context compact failed: ${formatAlertCause(cause, 300)}`,
                      },
                    })
                    .pipe(Effect.ignore),
                ),
              ),
            );

            return slashDefer();
          }).pipe(
            Effect.catch((error: unknown) =>
              Effect.succeed(
                slashReply(
                  `Compact failed: ${error instanceof Error ? error.message : String(error)}`,
                  { ephemeral: true },
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
              yield* links.setThreadTalkMode(channelId, actionRaw === "on" ? "all-messages" : null);
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

          assign: Effect.gen(function* () {
            const interaction = yield* Ix.Interaction;
            const channelId = interaction.channel_id;
            if (channelId === undefined || channelId.length === 0) {
              return slashReply("Assign only works inside a linked Discord thread.", {
                ephemeral: true,
              });
            }

            const channel = yield* rest.getChannel(channelId);
            if (!isThreadChannel(channel.type)) {
              return slashReply("Assign is only supported inside a linked Discord thread.", {
                ephemeral: true,
              });
            }

            const existing = yield* links.getByDiscordThreadId(channelId);
            if (existing === null) {
              return slashReply(
                "This Discord thread is not linked to a T3 thread, so there are no PRs to assign.",
                { ephemeral: true },
              );
            }

            const githubOption = (
              Option.getOrElse(HashMap.get(ix.optionsMap, "github"), () => "") ?? ""
            ).trim();
            const requesterId = interaction.member?.user?.id ?? interaction.user?.id ?? null;
            const resolved = resolveAssignGithubLogin({
              githubOption: githubOption.length > 0 ? githubOption : undefined,
              requesterDiscordId: requesterId,
              resolveByDiscordId: (discordId) => identityMap.resolveByDiscordId(discordId),
            });
            if (!resolved.ok) {
              return slashReply(resolved.message, { ephemeral: true });
            }

            const prUrls = existing.prUrls ?? [];
            if (prUrls.length === 0) {
              return slashReply(
                `No linked pull requests on this thread yet. Open or post a PR first, then run \`/agent assign\`.`,
                { ephemeral: true },
              );
            }

            // gh API can exceed Discord's ~3s window when multiple PRs are linked.
            const applicationId = interaction.application_id;
            const token = interaction.token;
            const login = resolved.login;
            yield* forkSlashBackground(
              Effect.gen(function* () {
                yield* Effect.sleep("250 millis");
                // assignPullRequestAssignees is best-effort (per-URL results; does not throw).
                const results = yield* Effect.promise(() =>
                  assignPullRequestAssignees({
                    prUrls,
                    login,
                  }),
                );
                const content = formatAssignSlashReply({ login, results });
                yield* Effect.logInfo("Discord slash assign completed", {
                  discordThreadId: channelId,
                  t3ThreadId: existing.t3ThreadId,
                  login,
                  source: resolved.source,
                  assigned: results.filter((r) => r.status === "assigned").length,
                  errors: results.filter((r) => r.status === "error").length,
                  actorId: requesterId,
                });
                yield* rest
                  .updateOriginalWebhookMessage(applicationId, token, {
                    payload: { content },
                  })
                  .pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("Failed to edit deferred assign response", {
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
                        content: `Assign failed: ${formatAlertCause(cause, 300)}`,
                      },
                    })
                    .pipe(Effect.ignore),
                ),
              ),
            );

            // Public so the thread sees who assigned whom.
            return slashDefer();
          }).pipe(
            Effect.catch((error: unknown) =>
              Effect.succeed(
                slashReply(
                  `Assign failed: ${error instanceof Error ? error.message : String(error)}`,
                  { ephemeral: true },
                ),
              ),
            ),
          ),

          export: respondToExport(exportCountRaw(ix.optionsMap)),
        });
      },
    );

  const omegentSlashCommand = makeSlashCommand(OMEGENT_SLASH_COMMAND_NAME);
  const agentSlashCommand = makeSlashCommand(OMEGENT_SLASH_COMMAND_ALIAS);
  const exportSlashCommand = Ix.guild(EXPORT_SLASH_COMMAND, (ix) =>
    respondToExport(exportCountRaw(ix.optionsMap)),
  );

  yield* registry.register(
    Ix.builder
      .add(omegentSlashCommand)
      .add(agentSlashCommand)
      .add(exportSlashCommand)
      .add(approvalButton)
      .add(denyButton)
      .add(stopButton)
      .add(continueButton)
      .add(startNewThreadButton)
      .catchAllCause(Effect.logError) as never,
  );

  yield* Effect.logInfo("Registered Discord slash commands", {
    commands: [OMEGENT_SLASH_COMMAND_NAME, OMEGENT_SLASH_COMMAND_ALIAS, EXPORT_SLASH_COMMAND.name],
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
  yield* Effect.forkScoped(handleThreadDeletes);
  yield* Effect.forkScoped(handleChannelDeletes);
  yield* Effect.logInfo("Discord mention router ready");
  return DiscordBotRunning.of({ botUserId });
});

export const MentionRouterLive = (botConfig: DiscordBotConfig) =>
  Layer.effect(DiscordBotRunning, make(botConfig));
