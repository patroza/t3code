// @effect-diagnostics anyUnknownInErrorContext:off missingEffectContext:off globalFetchInEffect:off unknownInEffectCatch:off nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import type {
  ChatImageAttachment,
  OrchestrationThread,
  ThreadId,
  VcsStatusChangeRequest,
  VcsStatusResult,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import { sessionNeedsWakeUp } from "@t3tools/shared/sessionWake";
import { resolveThreadChangeRequest } from "@t3tools/shared/sourceControl";
import {
  appendStatsToMessageChunks,
  formatTurnResponseStatsLine,
} from "@t3tools/shared/turnResponseStats";
import { Discord, DiscordConfig, DiscordREST, UI } from "dfx";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import { DiscordBotConfig } from "../config.ts";
import {
  buildStreamHistoryMarkdownText,
  DISCORD_MAX_FILES_PER_MESSAGE,
  imageAttachmentsOf,
  STREAM_HISTORY_MARKDOWN_NAME,
  streamHistoryHasAdditionalContent,
  unpostedAttachments,
} from "../presentation/attachments.ts";
import {
  createMessageWithAttachments,
  DiscordUploadError,
  textFile,
  type DiscordUploadFile,
} from "../presentation/discordFiles.ts";
import { formatModelSelectionLine } from "../presentation/threadInfoPin.ts";
import {
  assertFilesystemPath as assertFilesystemFilePath,
  extractMarkdownLocalFileLinks,
  fileNameForLocalFileRef,
  guessFileMimeType,
  isLocalFileSrc,
  replaceMarkdownLocalFileLinks,
  stripMarkdownLocalFileLinks,
  type MarkdownLocalFileRef,
} from "../presentation/markdownFiles.ts";
import {
  resolveGitHubBlobUrlForLocalPath,
  resolveGitHubBlobUrlForPathReference,
} from "../presentation/githubLinks.ts";
import { extractPullRequestUrls } from "../presentation/prLinks.ts";
import {
  assertFilesystemPath,
  extractMarkdownImages,
  fileNameForImageRef,
  guessImageMimeType,
  isLocalImageSrc,
  resolveImagePathOnDisk,
  stripMarkdownImages,
  type MarkdownImageRef,
} from "../presentation/markdownImages.ts";
import {
  chunkDiscordContentPreservingTables,
  rewriteMarkdownTablesForDiscord,
} from "../presentation/asciiTables.ts";
import {
  chunkDiscordContent,
  formatInProgressChunk,
  formatWakeUpTipContent,
  inProgressChunkLimit,
  idleMessageFields,
  nextWorkingDotCount,
  decorateDiscordThreadTitle,
  stripWorkingIndicator,
  type WorkingDotCount,
  wakeUpMessageFields,
  workingMessageFields,
} from "../presentation/messages.ts";
import {
  derivePendingInteractions,
  type PendingApproval,
} from "../presentation/pendingInteractions.ts";
import { formatTasksForDiscord, presentTasks } from "../presentation/tasks.ts";
import { countTurnToolCalls } from "../presentation/toolCalls.ts";
import { ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { ThreadWarmCacheStore } from "../store/ThreadWarmCacheStore.ts";
import { T3Session } from "../t3/T3Session.ts";
import { formatAlertCause, postBridgeAlert, postFatalAlert } from "./Alerts.ts";
import { BridgeHub, type BridgeControlSlot, type BridgeEnsureInput } from "./BridgeHub.ts";
import {
  assistantMessagesForDelivery,
  beginDeliveryEpoch,
  decideAssistantDelivery,
  decideHeartbeat,
  initialDeliveryEpochState,
  shouldRecreateTip,
  type DeliveryEpochState,
} from "./DiscordDelivery.ts";
import { upsertThreadInfoPin } from "./ThreadInfoPin.ts";

const DISCORD_LIMIT = 2000;
const STREAM_CHUNK_LIMIT = inProgressChunkLimit(DISCORD_LIMIT);
const DISCORD_CONSERVATIVE_UPLOAD_LIMIT_BYTES = 10_000_000;

interface BridgeState {
  /** T3 orchestration turn currently tracked by this bridge. */
  readonly currentTurnId: string | null;
  /** T3 orchestration assistant message id currently being streamed. */
  readonly t3AssistantMessageId: string | null;
  /** Full assistant text last applied to the in-progress Discord stream. */
  readonly lastAssistantText: string;
  /**
   * Discord messages that carry the current turn's *in-progress* stream (ordered tip slots).
   * On finalize these are deleted; their content is archived as stream-history.md.
   * May include the pre-bridge Working.. ack (seeded at start).
   */
  readonly discordMessageIds: ReadonlyArray<string>;
  /**
   * Extra stream message ids that were abandoned (e.g. tip ownership lost and replaced).
   * Always deleted on finalize / when starting a new assistant message.
   */
  readonly staleStreamMessageIds: ReadonlyArray<string>;
  /**
   * Full stream display text frozen when a user (or other) message displaced our tip.
   * Active tip messages after the break only show the *suffix* after this prefix so we
   * never re-copy pre-break content below the user message (order stays correct).
   */
  readonly streamBreakPrefix: string;
  readonly lastTasksKey: string;
  readonly taskDiscordMessageId: string | null;
  readonly lastApprovalKey: string;
  /** Whether we already published a final answer for this T3 turn. */
  readonly finalizedTurnId: string | null;
  /** Chat attachment ids already uploaded to Discord for the current T3 assistant message. */
  readonly postedAttachmentIds: ReadonlyArray<string>;
  /** Local markdown image srcs already uploaded for this T3 assistant message. */
  readonly postedMarkdownImageSrcs: ReadonlyArray<string>;
  /** Local markdown file srcs already uploaded for this T3 assistant message. */
  readonly postedMarkdownFileSrcs: ReadonlyArray<string>;
  /** Discord message ids of the final answer post(s), if any. */
  readonly finalDiscordMessageIds: ReadonlyArray<string>;
  /** Whether we already attached stream-history.md for this T3 assistant id. */
  readonly streamHistoryPosted: boolean;
  /**
   * After the first snapshot we adopt any prior completed assistant as "already
   * finalized" so re-subscribing a long-lived thread does not re-post old answers.
   */
  readonly adoptedInitialSnapshot: boolean;
  /** Last Discord thread title we successfully mirrored from the T3 thread title. */
  readonly mirroredThreadTitle: string | null;
  /** Title attempted by this bridge, preventing retries on every stream snapshot. */
  readonly attemptedThreadTitle: string | null;
  /**
   * A fresh Working.. ack was posted before `startTurn` dispatch. Keep it visible through
   * the bridge's initial idle snapshot, and only clear it once the new turn actually starts
   * (or explicit error cleanup removes it).
   */
  readonly seededWorkingAckPending: boolean;
  /** User message ids already observed by this bridge subscription. */
  readonly seenUserMessageIds: ReadonlyArray<string>;
  /** Whether the bridge has already treated one thread snapshot as baseline state. */
  readonly observedInitialUserSnapshot: boolean;
  /** User message ids sent into T3 by this Discord bot and therefore not echoed back. */
  readonly sentDiscordUserMessageIds: ReadonlyArray<string>;
  /**
   * Structural delivery epoch FSM (see DiscordDelivery.ts). Gates stream / finalize /
   * heartbeat so a finalized answer cannot reappear as Working.. under itself.
   */
  readonly delivery: DeliveryEpochState;
  /**
   * Converted an open Working tip into a wake-up notice for this bridge lifetime.
   * Prevents re-editing / re-posting the same notice on every snapshot.
   */
  readonly wakeUpNoticePosted: boolean;
}

export type DiscordBridgePresentationMode = "full" | "final-only";

/**
 * Discord Tasks side-channel lifecycle (one editable message per bridge).
 * Independent of External User Input echo and of Working stream tips.
 */
export function resolveTaskMessageAction(input: {
  readonly taskDiscordMessageId: string | null;
  readonly lastTasksKey: string;
  readonly nextTasksKey: string;
}): "skip" | "update" | "create" {
  if (input.lastTasksKey === input.nextTasksKey) return "skip";
  return input.taskDiscordMessageId === null ? "create" : "update";
}

/**
 * Message ids that must never steal Working tip ownership.
 * Includes stream tips, finals, Tasks side-post, info pin, and durable stream markers.
 */
export function discordBridgeOwnedMessageIds(input: {
  readonly discordMessageIds?: ReadonlyArray<string | null | undefined>;
  readonly staleStreamMessageIds?: ReadonlyArray<string | null | undefined>;
  readonly finalDiscordMessageIds?: ReadonlyArray<string | null | undefined>;
  readonly taskDiscordMessageId?: string | null | undefined;
  readonly infoDiscordMessageId?: string | null | undefined;
  readonly streamDiscordMessageIds?: ReadonlyArray<string | null | undefined>;
}): ReadonlyArray<string> {
  const ids: string[] = [];
  for (const group of [
    input.discordMessageIds,
    input.staleStreamMessageIds,
    input.finalDiscordMessageIds,
    input.streamDiscordMessageIds,
  ]) {
    for (const id of group ?? []) {
      const value = id?.trim() ?? "";
      if (value !== "") ids.push(value);
    }
  }
  for (const id of [input.taskDiscordMessageId, input.infoDiscordMessageId]) {
    const value = id?.trim() ?? "";
    if (value !== "") ids.push(value);
  }
  return ids;
}

/**
 * Normalize Discord message content for accept-without-ack idempotency checks.
 * Collapses whitespace and strips Working indicators so chunk compares stay stable.
 */
export function normalizeDiscordContentForIdempotency(content: string): string {
  return stripWorkingIndicator(content)
    .replace(/\u200b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Find bot-authored messages that already match the final answer chunks (oldest→newest).
 * Used when Discord accepted createMessage but we timed out before recording state —
 * retry must adopt those ids instead of posting a second final.
 *
 * Returns null when no complete contiguous match is found.
 */
export function findAlreadyPostedFinalChunkIds(input: {
  readonly recentMessages: ReadonlyArray<{
    readonly id: string;
    readonly authorId: string;
    readonly content: string;
  }>;
  readonly botUserId: string;
  readonly finalChunks: ReadonlyArray<string>;
  readonly excludeMessageIds?: ReadonlyArray<string>;
}): ReadonlyArray<string> | null {
  const chunks = input.finalChunks
    .map((chunk) => normalizeDiscordContentForIdempotency(chunk.trim() !== "" ? chunk : "_(done)_"))
    .filter((chunk) => chunk !== "");
  if (chunks.length === 0) return null;

  const exclude = new Set((input.excludeMessageIds ?? []).filter((id) => id.trim() !== ""));
  // listMessages is newest-first; walk oldest-first for contiguous chunk order.
  const botMessages = input.recentMessages
    .filter(
      (message) =>
        message.authorId === input.botUserId &&
        !exclude.has(message.id) &&
        normalizeDiscordContentForIdempotency(message.content) !== "",
    )
    .slice()
    .reverse();

  if (botMessages.length < chunks.length) return null;

  for (let start = 0; start <= botMessages.length - chunks.length; start += 1) {
    let matched = true;
    const ids: string[] = [];
    for (let offset = 0; offset < chunks.length; offset += 1) {
      const message = botMessages[start + offset]!;
      const body = normalizeDiscordContentForIdempotency(message.content);
      if (body !== chunks[offset]) {
        matched = false;
        break;
      }
      ids.push(message.id);
    }
    if (matched) return ids;
  }
  return null;
}

/**
 * Whether durable/in-memory finalize markers already claim this assistant was delivered.
 */
export function isAssistantAlreadyFinalizedOnDiscord(input: {
  readonly assistantId: string;
  readonly finalizedTurnId: string | null;
  readonly turnId: string | null;
  readonly lastFinalizedAssistantId: string | null | undefined;
  readonly durableLastFinalizedAssistantId: string | null | undefined;
}): boolean {
  if (
    input.finalizedTurnId !== null &&
    input.turnId !== null &&
    input.finalizedTurnId === input.turnId
  ) {
    return true;
  }
  if (input.lastFinalizedAssistantId === input.assistantId) return true;
  if (input.durableLastFinalizedAssistantId === input.assistantId) return true;
  return false;
}

/**
 * Discord message types that represent real chat content (user/bot).
 * System messages (channel name change=4, pin=6, etc.) must NOT steal stream tip ownership —
 * new threads rename early and otherwise freeze empty `_Working.._` while T3 streams.
 * @see https://discord.com/developers/docs/resources/message#message-object-message-types
 */
export function isDiscordContentMessageType(type: number | null | undefined): boolean {
  // 0 Default, 19 Reply. Treat missing type as content (older payloads).
  return type === null || type === undefined || type === 0 || type === 19;
}

/**
 * Newest-first message list → latest content message id (skips channel renames / pins).
 */
export function pickLatestContentMessageId(
  messages: ReadonlyArray<{ readonly id: string; readonly type?: number | null }>,
): string | null {
  return pickLatestContentMessage(messages)?.id ?? null;
}

/**
 * Newest-first message list → latest content message (skips channel renames / pins).
 */
export function pickLatestContentMessage<
  T extends { readonly id: string; readonly type?: number | null },
>(messages: ReadonlyArray<T>): T | null {
  for (const message of messages) {
    if (isDiscordContentMessageType(message.type)) {
      const id = message.id.trim();
      if (id !== "") return message;
    }
  }
  return null;
}

/**
 * Whether the stream tip should be frozen and reopened after a *foreign* channel tip.
 *
 * Only true when a non-owned *content* message is the latest (typically a human reply).
 * Bot side posts — live Tasks, stream chunks, finals, external-input echoes — and Discord
 * system messages (title renames, pins) must NOT break the tip. Otherwise empty
 * `_Working.._` freezes while T3 streams intermediate prose (common on new threads with
 * early renames, and when External User Input echoes land mid-turn).
 */
export function isStreamTipDisplacedByForeignMessage(input: {
  readonly latestMessageId: string | null;
  readonly streamTipId: string | null;
  readonly ownedMessageIds: ReadonlyArray<string | null | undefined>;
  /**
   * When the latest content message was authored by this Discord bot, never treat it as
   * foreign — side posts (Tasks, external echoes, info pins) often lack durable ownership
   * tracking and used to freeze the Working tip mid-turn.
   */
  readonly latestAuthorIsSelfBot?: boolean;
}): boolean {
  const tip = input.streamTipId?.trim() ?? "";
  if (tip === "") return false;
  const latest = input.latestMessageId?.trim() ?? "";
  if (latest === "") return false;
  if (latest === tip) return false;
  // Our own bot posts never steal tip ownership (even if not in ownedMessageIds yet).
  if (input.latestAuthorIsSelfBot === true) return false;
  const owned = new Set<string>();
  owned.add(tip);
  for (const id of input.ownedMessageIds) {
    const value = id?.trim() ?? "";
    if (value !== "") owned.add(value);
  }
  // Latest message is still one of ours (tasks / stream / final) — keep editing the tip.
  if (owned.has(latest)) return false;
  return true;
}

export function shouldPublishAssistantUpdate(input: {
  readonly presentationMode: DiscordBridgePresentationMode;
  readonly streaming: boolean;
}): boolean {
  return input.presentationMode === "full" || !input.streaming;
}

export function shouldArchiveStreamHistory(input: {
  readonly presentationMode: DiscordBridgePresentationMode;
  readonly hasStreamMessages: boolean;
}): boolean {
  return input.presentationMode === "full" && input.hasStreamMessages;
}

export function shouldReopenFinalizedDelivery(input: {
  readonly finalizedTurnId: string | null;
  readonly currentAssistantMessageId: string | null;
  readonly turnId: string | null;
  readonly nextAssistantMessageId: string;
}): boolean {
  return (
    input.finalizedTurnId !== null &&
    (input.finalizedTurnId !== input.turnId ||
      input.currentAssistantMessageId !== input.nextAssistantMessageId)
  );
}

/**
 * Dual-cursor lag: orchestration has advanced past what Discord successfully applied.
 *
 * - `lastThreadSnapshotSequence` advances when T3 state is observed (performant resume).
 * - `lastDeliveredSequence` advances only after `processThreadSnapshot` succeeds.
 *
 * When delivery is behind, keep HTTP-reconciling / rehydrating even if tips look clean
 * (crash between sequence persist and Discord I/O, hung REST, worker death mid-queue).
 *
 * Storage/memory contract: both cursors are O(1) scalars on the link row. We never
 * persist or keep an event log of pre-sync history — only these markers + tip ids.
 */
export function isDeliveryBehindOrchestration(input: {
  readonly lastDeliveredSequence: number | null | undefined;
  readonly lastThreadSnapshotSequence: number | null | undefined;
}): boolean {
  const observed = input.lastThreadSnapshotSequence;
  const delivered = input.lastDeliveredSequence;
  // Both cursors must be known. A null delivery cursor means pre-dual-cursor links or
  // a brand-new link — do not force rehydrate of every historical link on upgrade.
  // Open tips / awaiting-final / turn-in-progress still drive recovery in those cases.
  // Once delivery has been written at least once, lag is strict sequence comparison.
  if (observed === null || observed === undefined || !Number.isFinite(observed)) {
    return false;
  }
  if (delivered === null || delivered === undefined || !Number.isFinite(delivered)) {
    return false;
  }
  return delivered < observed;
}

/**
 * How many sequences to rewind when resuming the WS stream so a mid-delivery race
 * can re-observe a tiny tail. Not history storage — just a resume offset.
 */
export const SUBSCRIBE_SEQUENCE_BUFFER = 2 as const;

function finiteSequenceOrNull(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value;
}

/**
 * Choose `subscribeThread({ afterSequence })` so we do **not** re-walk the WS event
 * log before what Discord has already synced (minus a small buffer).
 *
 * Preference order:
 * 1. `lastDeliveredSequence` — safe high-water for "already applied to Discord"
 * 2. else `lastThreadSnapshotSequence` — legacy / first-write before delivery cursor exists
 *
 * Returns null for cold subscribe (no durable cursor yet). Never returns a cursor that
 * requires loading stored pre-sync event history — only a number for the server filter.
 */
export function resolveSubscribeAfterSequence(input: {
  readonly lastDeliveredSequence: number | null | undefined;
  readonly lastThreadSnapshotSequence: number | null | undefined;
  readonly buffer?: number;
}): number | null {
  const buffer = Math.max(0, input.buffer ?? SUBSCRIBE_SEQUENCE_BUFFER);
  const delivered = finiteSequenceOrNull(input.lastDeliveredSequence);
  const observed = finiteSequenceOrNull(input.lastThreadSnapshotSequence);
  // Prefer delivery cursor: skip everything Discord already applied.
  // When lagging, this is *behind* orchestration — intentional: re-sync only the
  // unsynced tail (+buffer), not the whole thread event log from 0.
  const anchor = delivered ?? observed;
  if (anchor === null) return null;
  return Math.max(0, anchor - buffer);
}

/**
 * How many already-finalized messages to keep before `lastFinalizedAssistantId`
 * for growth reopen / settle edge cases. Everything older is dropped from the
 * in-memory and warm-cache OrchestrationThread.
 */
export const DISCORD_DELIVERED_MESSAGE_MEMORY_BUFFER = 2 as const;

/**
 * Drop messages Discord has already successfully finalized, keeping a small
 * buffer before the finalize watermark plus everything after it (active turn).
 */
export function trimOrchestrationThreadForDiscordMemory(input: {
  readonly thread: OrchestrationThread;
  readonly lastFinalizedAssistantId: string | null | undefined;
  readonly buffer?: number;
}): OrchestrationThread {
  const finalizedId = input.lastFinalizedAssistantId?.trim() ?? "";
  if (finalizedId === "") return input.thread;
  const buffer = Math.max(0, input.buffer ?? DISCORD_DELIVERED_MESSAGE_MEMORY_BUFFER);
  const messages = input.thread.messages;
  const finalizedIdx = messages.findIndex((message) => message.id === finalizedId);
  if (finalizedIdx < 0) return input.thread;
  const start = Math.max(0, finalizedIdx - buffer);
  if (start === 0) return input.thread;
  return {
    ...input.thread,
    messages: messages.slice(start),
  };
}

/**
 * Prefer durable warm base (like web/desktop cache) over HTTP full tip when present.
 */
export function resolveThreadSubscribeSeed(input: {
  readonly warm: {
    readonly snapshotSequence: number;
    readonly thread: OrchestrationThread;
  } | null;
  readonly afterSequence: number | null;
}):
  | { readonly kind: "warm"; readonly thread: OrchestrationThread; readonly afterSequence: number }
  | { readonly kind: "http"; readonly afterSequence: number }
  | { readonly kind: "cold" } {
  if (
    input.warm !== null &&
    Number.isFinite(input.warm.snapshotSequence) &&
    input.warm.snapshotSequence >= 0
  ) {
    return {
      kind: "warm",
      thread: input.warm.thread,
      afterSequence: input.warm.snapshotSequence,
    };
  }
  if (input.afterSequence !== null && input.afterSequence >= 0) {
    return { kind: "http", afterSequence: input.afterSequence };
  }
  return { kind: "cold" };
}

/**
 * Whether the bridge should poll T3 over HTTP for a fresh snapshot.
 *
 * WS event delivery can stall (no thread updates for long stretches while the agent
 * still works). Open Working.. tips / in-progress turns must not rely on WS alone.
 *
 * Also keeps polling after a Discord-originated user turn until we finalize at least
 * once for that bridge session — covers turns that never posted a Working tip and
 * never received WS assistant events (T3 UI still advances).
 *
 * Dual-cursor lag (`deliveryLagging`) recovers cases where orchestration advanced but
 * Discord I/O never completed for that sequence.
 */
export function bridgeNeedsHttpReconcile(input: {
  readonly openStreamTipCount: number;
  readonly seededWorkingAckPending: boolean;
  readonly turnInProgress: boolean;
  /**
   * True when we still owe Discord a final answer for work this bridge started
   * (e.g. sent a user message / Working ack but finalizedTurnId is still null).
   */
  readonly awaitingDiscordFinal: boolean;
  /** True when lastDeliveredSequence lags lastThreadSnapshotSequence. */
  readonly deliveryLagging?: boolean;
}): boolean {
  if (input.seededWorkingAckPending) return true;
  if (input.openStreamTipCount > 0) return true;
  if (input.turnInProgress) return true;
  if (input.awaitingDiscordFinal) return true;
  if (input.deliveryLagging === true) return true;
  return false;
}

/** How often each live bridge re-fetches thread state when {@link bridgeNeedsHttpReconcile}. */
export const BRIDGE_HTTP_RECONCILE_INTERVAL = "12 seconds" as const;

/** Cap Discord finalize create/edit work so a hung REST call cannot pin the delivery queue. */
export const BRIDGE_FINALIZE_DISCORD_TIMEOUT = "45 seconds" as const;

/**
 * Cap live stream tip create/edit work. Stream path previously had no timeout; a hung
 * Discord REST call held the delivery lock forever so later assistants never reached
 * Discord while T3 kept advancing (stuck `_Working.._` with live intermediate text in T3).
 */
export const BRIDGE_STREAM_DISCORD_TIMEOUT = "30 seconds" as const;

/**
 * Outer cap for one coalesced `processThreadSnapshot` pass (primary stream/finalize +
 * best-effort secondary). Kept high enough for a finalize multipart upload.
 */
export const BRIDGE_PROCESS_SNAPSHOT_TIMEOUT = "90 seconds" as const;

/**
 * Cap title / pin / tasks / approvals so secondary Discord work cannot burn the whole
 * processThreadSnapshot budget and trip the outer TimeoutError while the tip already
 * has (or needs) stream content.
 */
export const BRIDGE_SECONDARY_DISCORD_TIMEOUT = "20 seconds" as const;

/** Immediate in-worker retries after processThreadSnapshot failure before deferring to HTTP reconcile. */
export const BRIDGE_DELIVERY_FAILURE_MAX_RETRIES = 5 as const;

/**
 * Backoff between in-worker delivery retries after TimeoutError / process failure.
 * failureCount is 1-based (after increment). Caps at 30s.
 */
export function deliveryFailureBackoffSeconds(failureCount: number): number {
  const n = Math.max(1, Math.floor(failureCount));
  return Math.min(30, 2 ** Math.min(n, 5));
}

export function shouldRetryDeliveryFailure(input: {
  readonly failureCount: number;
  readonly maxRetries?: number;
}): boolean {
  const max = input.maxRetries ?? BRIDGE_DELIVERY_FAILURE_MAX_RETRIES;
  return input.failureCount >= 1 && input.failureCount <= max;
}

/**
 * On bridge fiber stop (restart, reconnect dropAll, channel re-ensure), keep open
 * stream tips on Discord when a turn is still running so rehydrate can resume them.
 *
 * This is the correct mid-turn resume strategy — **not** repainting the previous
 * turn's final answer under a new Working tip. New interactive turns orphan-clean
 * prior tip ids via {@link seedStreamMessageIds} / {@link nextBridgeStateAfterAdoptWorkingAck}.
 */
export function shouldPreserveStreamTipsOnBridgeStop(input: {
  readonly turnInProgress: boolean;
  readonly openStreamTipCount: number;
}): boolean {
  return input.turnInProgress && input.openStreamTipCount > 0;
}

/** Stable synthetic assistant id used only to reseed a Working tip with no prose yet. */
export const REHYDRATE_WORKING_PLACEHOLDER_ID = "rehydrate:working-tip";

/**
 * Body text for the Working heartbeat tip.
 *
 * While a fresh Working ack is pending for a new user turn, never paint prior-turn
 * `lastAssistantText` (that re-shows the previous answer under Working..).
 */
export function streamTipBodyForHeartbeat(input: {
  readonly seededWorkingAckPending: boolean;
  readonly lastAssistantText: string;
  readonly streamBreakPrefix: string;
}): string {
  if (input.seededWorkingAckPending) return "";
  return activeStreamTipText(streamDisplayText(input.lastAssistantText), input.streamBreakPrefix);
}

/**
 * Hold a fresh Working ack without painting snapshot assistant body.
 *
 * Only while the *current* turn has no assistant bubbles yet. Blanket holding for
 * the whole `seededWorkingAckPending` lifetime blocked legitimate new-turn stream
 * writes (pending never cleared) or, when pending was cleared elsewhere, still
 * allowed prior-turn bodies through once latestTurn lagged.
 */
export function shouldHoldFreshWorkingAck(input: {
  readonly mode: "interactive" | "rehydrate";
  readonly seededWorkingAckPending: boolean;
  /** Assistants belonging to the active turn only (see {@link assistantMessagesThisTurn}). */
  readonly currentTurnAssistantCount: number;
}): boolean {
  return (
    input.mode === "interactive" &&
    input.seededWorkingAckPending &&
    input.currentTurnAssistantCount === 0
  );
}

/**
 * Active tip message ids for a streaming write.
 *
 * On a new delivery (new turn / fresh Working ack), keep only the newest tip slot
 * so we never edit prior-turn message ids (Discord 10008 Unknown Message).
 */
export function activeStreamTipIdsForDelivery(input: {
  readonly startsNewDelivery: boolean;
  readonly discordMessageIds: ReadonlyArray<string>;
  readonly staleStreamMessageIds: ReadonlyArray<string>;
}): {
  readonly discordMessageIds: ReadonlyArray<string>;
  readonly staleStreamMessageIds: ReadonlyArray<string>;
} {
  if (!input.startsNewDelivery) {
    return {
      discordMessageIds: [...input.discordMessageIds],
      staleStreamMessageIds: [...input.staleStreamMessageIds],
    };
  }
  const tip =
    input.discordMessageIds.length > 0
      ? input.discordMessageIds[input.discordMessageIds.length - 1]!
      : null;
  return {
    discordMessageIds: tip !== null ? [tip] : [],
    staleStreamMessageIds: uniqueDiscordMessageIds([
      ...input.staleStreamMessageIds,
      ...input.discordMessageIds.slice(0, -1),
    ]),
  };
}

/**
 * Whether streaming should treat this write as a brand-new tip delivery
 * (clear last body / tip history), not a mid-turn edit of the same turn.
 */
export function startsNewStreamDelivery(input: {
  readonly currentTurnId: string | null;
  readonly nextTurnId: string | null;
  readonly reopensFinalizedDelivery: boolean;
  readonly seededWorkingAckPending: boolean;
}): boolean {
  return (
    input.currentTurnId !== input.nextTurnId ||
    input.reopensFinalizedDelivery ||
    input.seededWorkingAckPending
  );
}

/**
 * Pure state patch when a Discord Working.. ack is adopted for a new user turn
 * (or mid-turn steer) on a reused bridge. Clears prior stream body and points the
 * live tip at the new Working ack only.
 *
 * `orphanTipsToDelete` is misnamed historically: callers **freeze** those tips
 * (strip Working.. + Stop) and leave them as channel history above the human message;
 * only empty Working-only orphans are deleted.
 */
export function nextBridgeStateAfterAdoptWorkingAck(input: {
  readonly priorDiscordMessageIds: ReadonlyArray<string>;
  readonly priorStaleStreamMessageIds: ReadonlyArray<string>;
  readonly workingAckMessageId: string;
}): {
  readonly discordMessageIds: ReadonlyArray<string>;
  readonly staleStreamMessageIds: ReadonlyArray<string>;
  /** Prior tip ids to freeze (or delete if empty Working-only). */
  readonly orphanTipsToDelete: ReadonlyArray<string>;
  readonly lastAssistantText: string;
  readonly streamBreakPrefix: string;
  readonly currentTurnId: null;
  readonly t3AssistantMessageId: null;
  readonly finalizedTurnId: null;
  readonly finalDiscordMessageIds: ReadonlyArray<string>;
  readonly streamHistoryPosted: false;
  readonly postedAttachmentIds: ReadonlyArray<string>;
  readonly postedMarkdownImageSrcs: ReadonlyArray<string>;
  readonly postedMarkdownFileSrcs: ReadonlyArray<string>;
  readonly seededWorkingAckPending: true;
} {
  const orphanTipsToDelete = input.priorDiscordMessageIds.filter(
    (id) => id !== input.workingAckMessageId,
  );
  return {
    discordMessageIds: [input.workingAckMessageId],
    // Do not re-queue orphans as stale live tips — they become frozen history.
    staleStreamMessageIds: [...input.priorStaleStreamMessageIds].filter(
      (id) => id !== input.workingAckMessageId && !orphanTipsToDelete.includes(id),
    ),
    orphanTipsToDelete,
    lastAssistantText: "",
    streamBreakPrefix: "",
    currentTurnId: null,
    t3AssistantMessageId: null,
    finalizedTurnId: null,
    finalDiscordMessageIds: [],
    streamHistoryPosted: false,
    postedAttachmentIds: [],
    postedMarkdownImageSrcs: [],
    postedMarkdownFileSrcs: [],
    seededWorkingAckPending: true,
  };
}

/**
 * After a stream tip update fails (e.g. Discord 10008 Unknown Message), recreate
 * when the turn is still running so Discord does not go dark.
 */
export function shouldRecreateStreamTipOnUpdateFailure(input: {
  readonly turnInProgress: boolean;
  readonly updateFailed: boolean;
}): boolean {
  return input.updateFailed && input.turnInProgress;
}

/**
 * Rehydrate/resume should always attempt a streaming tip write for a running turn,
 * including empty progress (Working-only), so restarts never leave Discord without
 * a liveness bubble while T3 is still busy.
 */
export function shouldPublishRehydrateResumeTip(input: {
  readonly presentationMode: DiscordBridgePresentationMode;
  readonly turnInProgress: boolean;
}): boolean {
  return (
    input.turnInProgress &&
    shouldPublishAssistantUpdate({
      presentationMode: input.presentationMode,
      streaming: true,
    })
  );
}

const emptyState = (seed?: {
  readonly workingAckMessageId?: string | null;
  readonly lastFinalizedAssistantId?: string | null;
}): BridgeState => {
  const hasWorkingAck =
    seed?.workingAckMessageId !== undefined &&
    seed.workingAckMessageId !== null &&
    seed.workingAckMessageId !== "";
  const lastFinalized = seed?.lastFinalizedAssistantId ?? null;
  return {
    currentTurnId: null,
    t3AssistantMessageId: null,
    lastAssistantText: "",
    // Reuse the router's Working.. ack as the first stream tip so it is edited/deleted.
    discordMessageIds: hasWorkingAck ? [seed!.workingAckMessageId!] : [],
    staleStreamMessageIds: [],
    streamBreakPrefix: "",
    lastTasksKey: "",
    taskDiscordMessageId: null,
    lastApprovalKey: "",
    finalizedTurnId: null,
    postedAttachmentIds: [],
    postedMarkdownImageSrcs: [],
    postedMarkdownFileSrcs: [],
    finalDiscordMessageIds: [],
    streamHistoryPosted: false,
    adoptedInitialSnapshot: false,
    mirroredThreadTitle: null,
    attemptedThreadTitle: null,
    seededWorkingAckPending: hasWorkingAck,
    seenUserMessageIds: [],
    observedInitialUserSnapshot: false,
    sentDiscordUserMessageIds: [],
    delivery: initialDeliveryEpochState({
      epoch: hasWorkingAck ? 1 : 0,
      phase: hasWorkingAck ? "awaiting" : "idle",
      lastFinalizedAssistantId: lastFinalized,
      lastFinalizedText: null,
      settleReady: false,
    }),
    wakeUpNoticePosted: false,
  };
};

function uniqueDiscordMessageIds(ids: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(ids.filter((id) => id.trim() !== ""))];
}

function uniqueMessageIds(ids: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(ids.filter((id) => id.trim() !== ""))];
}

/**
 * Live bridge handle per Discord channel.
 * Mid-turn follow-ups re-use this handle instead of interrupting the fiber
 * (which used to drop in-memory stream tips and re-seed a blank Working.. tip).
 */
export type { LiveDiscordBridge } from "./BridgeHub.ts";

export const getLiveDiscordBridge = (discordChannelId: string, t3ThreadId: string) =>
  Effect.gen(function* () {
    const hub = yield* BridgeHub;
    return yield* hub.getLive(discordChannelId, t3ThreadId);
  });

function summarizeBridgeStateForLog(state: BridgeState) {
  return {
    currentTurnId: state.currentTurnId,
    t3AssistantMessageId: state.t3AssistantMessageId,
    discordMessageIds: [...state.discordMessageIds],
    staleStreamMessageIds: [...state.staleStreamMessageIds],
    streamBreakPrefixLen: state.streamBreakPrefix.length,
    finalDiscordMessageIds: [...state.finalDiscordMessageIds],
    taskDiscordMessageId: state.taskDiscordMessageId,
    lastAssistantTextLength: state.lastAssistantText.length,
    finalizedTurnId: state.finalizedTurnId,
    streamHistoryPosted: state.streamHistoryPosted,
    adoptedInitialSnapshot: state.adoptedInitialSnapshot,
    seededWorkingAckPending: state.seededWorkingAckPending,
    deliveryEpoch: state.delivery.epoch,
    deliveryPhase: state.delivery.phase,
    lastFinalizedAssistantId: state.delivery.lastFinalizedAssistantId,
  };
}

/**
 * True when the T3 UI would show "Wake Required" for this thread snapshot.
 * Requires incomplete-turn evidence so zombie interrupted sessions stay quiet.
 */
export function isSessionWakeRequired(
  thread: {
    readonly session?: {
      readonly status?: string | null;
      readonly activeTurnId?: string | null;
    } | null;
    readonly latestTurn?: {
      readonly state?: string | null;
      readonly completedAt?: string | null;
    } | null;
  } | null,
): boolean {
  if (thread === null) return false;
  return sessionNeedsWakeUp({
    sessionStatus: thread.session?.status ?? null,
    activeTurnId: thread.session?.activeTurnId ?? null,
    latestTurnState: thread.latestTurn?.state ?? null,
    latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
  });
}

/**
 * Discord "in progress" is turn-scoped, not message-scoped.
 *
 * Codex/ACP often emits several assistant bubbles per turn (between tools). Each
 * bubble ends with `message.streaming === false` while `latestTurn.state` is still
 * `running`. Treating that as finalize posts stream-history.md mid-turn and
 * creates new Discord messages instead of editing the tip.
 *
 * Only leave stream mode when the turn itself is no longer running.
 * Interrupted sessions that need wake-up are never treated as live streaming.
 */
function isTurnInProgress(thread: OrchestrationThread): boolean {
  if (isSessionWakeRequired(thread)) return false;
  // Authoritative: turn still running (multi-step agents keep this while tools run).
  if (thread.latestTurn?.state === "running") return true;
  // No turn object yet but session already spinning up / running.
  if (
    (thread.latestTurn === null || thread.latestTurn === undefined) &&
    (thread.session?.status === "running" || thread.session?.status === "starting")
  ) {
    return true;
  }
  return false;
}

/**
 * When a Working tip is still open after a real mid-turn interrupt (server
 * restart / orphan settle), convert it to a wake-up notice instead of deleting it.
 * Does not fire for zombie interrupted sessions with no unfinished turn.
 */
export function shouldConvertWorkingTipsToWakeUp(input: {
  readonly sessionStatus: string | null | undefined;
  readonly activeTurnId?: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
  readonly latestTurnCompletedAt?: string | null | undefined;
  readonly turnInProgress: boolean;
  readonly openStreamTipCount: number;
  readonly wakeUpNoticePosted: boolean;
}): boolean {
  if (input.wakeUpNoticePosted) return false;
  if (input.turnInProgress) return false;
  if (input.openStreamTipCount <= 0) return false;
  return sessionNeedsWakeUp({
    sessionStatus: input.sessionStatus,
    activeTurnId: input.activeTurnId,
    latestTurnState: input.latestTurnState,
    latestTurnCompletedAt: input.latestTurnCompletedAt,
  });
}

function isAssistantStreaming(thread: OrchestrationThread, assistantId: string): boolean {
  if (isTurnInProgress(thread)) return true;
  const message = thread.messages.find((entry) => entry.id === assistantId);
  return message?.streaming === true;
}

export function shouldDropSeededWorkingAckOnInitialSnapshot(input: {
  readonly adoptedInitialSnapshot: boolean;
  readonly seededWorkingAckPending: boolean;
  readonly streaming: boolean;
  readonly turnInProgress: boolean;
}): boolean {
  void input;
  // The initial Discord ack exists specifically to cover the gap before the next
  // stream or final state is ready. Clearing it on the first pre-start snapshot
  // causes a visible blink: Working.. disappears, then reappears once streaming starts.
  // Keep it until a replacement is posted or the turn later settles with nothing to show.
  return false;
}

/**
 * Decide how the first thread snapshot should be applied to Discord.
 *
 * Important: do not require `!streaming` here. Turn-in-progress always reports
 * streaming=true, and the old guard made rehydrate-of-running-turns unreachable.
 */
export function firstSnapshotBridgeAction(input: {
  readonly mode: "interactive" | "rehydrate";
  readonly turnInProgress: boolean;
  readonly hasContent: boolean;
  readonly alreadyFinalizedOnDiscord: boolean;
  readonly hasOpenTips: boolean;
}): "catch-up-finalize" | "rehydrate-resume" | "adopt-completed" | "interactive-resume" | "skip" {
  if (input.mode === "rehydrate" && !input.turnInProgress) {
    if (input.hasContent && (!input.alreadyFinalizedOnDiscord || input.hasOpenTips)) {
      return "catch-up-finalize";
    }
    return "adopt-completed";
  }
  if (input.mode === "rehydrate" && input.turnInProgress) {
    return "rehydrate-resume";
  }
  if (!input.turnInProgress) {
    return "adopt-completed";
  }
  return "interactive-resume";
}

/**
 * Where a user-role T3 message came from, inferred from prompt envelopes.
 *
 * OrchestrationMessage has no first-class `source` field yet, so surfaces are classified
 * from known ingress builders (Discord bot, GitHub PR bridge, agent harness). Plain text
 * defaults to `t3-client` (web / desktop / mobile / API).
 *
 * Cross-surface policy: a surface should only *echo* messages from other surfaces.
 * Discord bot echoes `github` + `t3-client`, never `discord` or `internal`.
 *
 * **Discord Tasks are not an ingress surface.** They are a first-class side-channel
 * projected from `turn.plan.updated` activities via {@link presentTasks} /
 * {@link formatTasksForDiscord} / `taskDiscordMessageId` — never from user-message echo.
 * Tasks posts must stay bot-owned (do not freeze Working tips) and keep updating mid-turn.
 */
export type UserMessageIngressSurface = "discord" | "github" | "t3-client" | "internal";

/** Surfaces Discord may post as External User Input (whitelist). */
export const DISCORD_EXTERNAL_ECHO_SURFACES: ReadonlySet<UserMessageIngressSurface> = new Set([
  "github",
  "t3-client",
]);

/**
 * True when text matches the Discord Tasks side-post body (`**Tasks N/M**`…).
 * Those posts are bot-authored progress UI, not External User Input and not stream tips.
 */
export function isDiscordTasksSidePostContent(text: string): boolean {
  return /^\*\*Tasks\s+\d+\s*\/\s*\d+\*\*/u.test(text.trim());
}

/**
 * Classify a user-role message body by ingress surface (content heuristics).
 * Prefer durable message ids (`sentDiscordUserMessageIds`) when available; this is the
 * content fallback for rehydrate / id mismatch / non-Discord injectors.
 */
export function classifyUserMessageIngress(text: string): UserMessageIngressSurface {
  const body = text.trim();
  if (body === "") return "t3-client";

  // Agent harness / runtime scaffolding (not a human client).
  if (isInternalAgentScaffoldingUserText(body)) return "internal";

  // Never re-echo our own Tasks side-post body if it somehow re-enters as user text.
  if (isDiscordTasksSidePostContent(body)) return "internal";

  // Discord mention / bootstrap path (buildDiscordTurnPrompt / buildSentryBootstrapPrompt).
  if (isDiscordOriginatedUserPrompt(body)) return "discord";

  // GitHub PR bridge (buildGitHubTurnPrompt).
  if (isGitHubOriginatedUserPrompt(body)) return "github";

  // Default: T3 client (web/desktop/mobile) or unlabeled API turn.
  return "t3-client";
}

/**
 * User prompts this bot injected into T3 (Discord mention / bootstrap path).
 * Never mirror these back into Discord as "External User Input" — they originated here.
 */
export function isDiscordOriginatedUserPrompt(text: string): boolean {
  const body = text.trim();
  if (body === "") return false;
  // buildDiscordTurnPrompt / buildSentryBootstrapPrompt markers.
  if (body.includes("## Discord conversation context")) return true;
  if (body.includes("## Discord investigation bootstrap")) return true;
  // Older / compact Discord turn envelopes still include these sections together.
  if (body.includes("### Current requester") && body.includes("## User request")) return true;
  return false;
}

/**
 * GitHub PR App turns (buildGitHubTurnPrompt). Echo these on Discord; do not treat as Discord.
 */
export function isGitHubOriginatedUserPrompt(text: string): boolean {
  const body = text.trim();
  if (body === "") return false;
  if (body.includes("## GitHub pull request context")) return true;
  // Visible header after HTML comment strip: "From GH [login](...) on [PR #N](...):"
  if (/^From GH\s+\[/mu.test(body) || /\nFrom GH\s+\[/u.test(body)) return true;
  return false;
}

/**
 * Internal agent / runtime scaffolding that can appear as user-role text in T3
 * (tool completion notices, harness reminders). Not a real human/web/GitHub client.
 */
export function isInternalAgentScaffoldingUserText(text: string): boolean {
  const body = text.trim();
  if (body === "") return false;
  // Grok / agent harness system reminders (background task completion, etc.).
  if (/<\s*system-reminder\b/iu.test(body)) return true;
  if (/<\/\s*system-reminder\s*>/iu.test(body)) return true;
  // Common body when the wrapper tag is stripped but the notice remains.
  if (/^Background task\s+"/iu.test(body) && /completed\s*\(exit code:/iu.test(body)) {
    return true;
  }
  // Other harness / tool XML shells that sometimes land as user-role text.
  if (/<\s*system(?:-|\s)?(?:message|context|notification)\b/iu.test(body)) return true;
  if (/<\s*tool_(?:result|response|call)\b/iu.test(body)) return true;
  return false;
}

/**
 * True when a user-role message must not be mirrored to Discord as External User Input.
 * Prefer {@link classifyUserMessageIngress} + whitelist; this remains for call sites/tests.
 */
export function shouldSuppressExternalUserEcho(text: string): boolean {
  return !DISCORD_EXTERNAL_ECHO_SURFACES.has(classifyUserMessageIngress(text));
}

/**
 * Whether Discord should post this user message as External User Input.
 * Whitelist: github + t3-client only (never same-surface Discord, never internal).
 */
export function shouldEchoUserMessageToDiscord(input: {
  readonly text: string;
  readonly messageId: string;
  readonly seenUserMessageIds: ReadonlySet<string> | ReadonlyArray<string>;
  readonly sentDiscordUserMessageIds: ReadonlySet<string> | ReadonlyArray<string>;
}): boolean {
  const seen =
    input.seenUserMessageIds instanceof Set
      ? input.seenUserMessageIds
      : new Set(input.seenUserMessageIds);
  const sentByDiscord =
    input.sentDiscordUserMessageIds instanceof Set
      ? input.sentDiscordUserMessageIds
      : new Set(input.sentDiscordUserMessageIds);
  if (seen.has(input.messageId) || sentByDiscord.has(input.messageId)) return false;
  return DISCORD_EXTERNAL_ECHO_SURFACES.has(classifyUserMessageIngress(input.text));
}

export function externalUserMessagesToEcho(input: {
  readonly messages: OrchestrationThread["messages"];
  readonly observedInitialUserSnapshot: boolean;
  readonly seenUserMessageIds: ReadonlyArray<string>;
  readonly sentDiscordUserMessageIds: ReadonlyArray<string>;
}): ReadonlyArray<OrchestrationThread["messages"][number]> {
  if (!input.observedInitialUserSnapshot) return [];
  const seen = new Set(input.seenUserMessageIds);
  const sentByDiscord = new Set(input.sentDiscordUserMessageIds);
  return input.messages.filter(
    (message) =>
      message.role === "user" &&
      shouldEchoUserMessageToDiscord({
        text: message.text,
        messageId: message.id,
        seenUserMessageIds: seen,
        sentDiscordUserMessageIds: sentByDiscord,
      }),
  );
}

export function summarizeExternalUserInput(text: string): string {
  // Drop HTML comment blocks (GitHub PR context) and system-reminder envelopes so
  // anything that still slips through the echo filter is less noisy.
  return text
    .replace(/<!--[\s\S]*?-->\s*/gu, "")
    .replace(/<\s*system-reminder\b[^>]*>[\s\S]*?<\/\s*system-reminder\s*>/giu, "")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

export function threadTitleChangeRequestState(
  thread: Pick<OrchestrationThread, "branch" | "worktreePath" | "messages">,
  pr: Pick<VcsStatusChangeRequest, "state"> | null | undefined,
): "initialized" | "open" | "merged" | "closed" | null {
  const hasAssistantMessage = thread.messages.some((message) => message.role === "assistant");
  if (!hasAssistantMessage) return null;
  if (thread.branch === null || thread.worktreePath === null) return null;
  return pr?.state ?? "initialized";
}

/**
 * Sticky PR evidence for Discord title badges.
 * Transient null lookups must not erase a previously observed PR — that is the
 * ▫️ ⇄ ❌🔀 flip-flop when VCS stream starts before remote is warm, or GH rate-limits.
 */
export type StickyTitlePrEvidence = Pick<VcsStatusChangeRequest, "state" | "number"> & {
  readonly hasFailingChecks?: boolean;
};

export function toStickyTitlePrEvidence(
  pr:
    | (Pick<VcsStatusChangeRequest, "state" | "number"> & {
        readonly hasFailingChecks?: boolean | undefined;
      })
    | null
    | undefined,
): StickyTitlePrEvidence | null {
  if (pr === null || pr === undefined) return null;
  return {
    state: pr.state,
    number: pr.number,
    ...(pr.hasFailingChecks === undefined ? {} : { hasFailingChecks: pr.hasFailingChecks }),
  };
}

/**
 * Merge PR observations into sticky evidence.
 * - null/undefined next = unknown (keep previous)
 * - same open PR keeps hasFailingChecks=true until an explicit false arrives
 */
export function mergeStickyTitlePr(
  previous: StickyTitlePrEvidence | null,
  next: StickyTitlePrEvidence | null | undefined,
): StickyTitlePrEvidence | null {
  if (next === null || next === undefined) return previous;
  if (previous === null) return next;

  const keepFailing =
    previous.number === next.number &&
    previous.state === "open" &&
    next.state === "open" &&
    previous.hasFailingChecks === true &&
    next.hasFailingChecks !== false;

  return {
    state: next.state,
    number: next.number,
    ...(keepFailing
      ? { hasFailingChecks: true }
      : next.hasFailingChecks === undefined
        ? {}
        : { hasFailingChecks: next.hasFailingChecks }),
  };
}

/**
 * Single place to decide PR evidence for Discord title sync.
 *
 * Prefer one warm source (VCS remote status) once observed; optional GH branch
 * lookup only bootstraps when remote has not been observed yet. Never treat
 * "remote not loaded" as "no PR" — that paints ▫️ and thrash-renames old threads.
 */
export function resolveDiscordTitlePrEvidence(input: {
  readonly stickyPr: StickyTitlePrEvidence | null;
  readonly statusPr: StickyTitlePrEvidence | null | undefined;
  readonly remoteStatusObserved: boolean;
  readonly branchLookupPr?: StickyTitlePrEvidence | null;
  readonly branchLookupCompleted?: boolean;
}): {
  readonly stickyPr: StickyTitlePrEvidence | null;
  readonly effectivePr: StickyTitlePrEvidence | null;
  /** True only when we may paint the no-PR `initialized` (▫️) badge. */
  readonly canApplyNoPrBadge: boolean;
} {
  let sticky = input.stickyPr;
  // Positive observations always stick.
  sticky = mergeStickyTitlePr(sticky, input.statusPr);
  if (input.branchLookupCompleted === true) {
    sticky = mergeStickyTitlePr(sticky, input.branchLookupPr ?? null);
  }

  const canApplyNoPrBadge =
    sticky === null && (input.remoteStatusObserved || input.branchLookupCompleted === true);

  return {
    stickyPr: sticky,
    effectivePr: sticky,
    canApplyNoPrBadge,
  };
}

/** PR / change-request title column (optional). */
export type DiscordThreadPrBadgeState = "initialized" | "open" | "merged" | "closed" | null;

/** Working / lifecycle title column (optional). */
export type DiscordThreadActivityBadgeState = "busy" | "wake-required" | null;

/**
 * Dual-slot Discord title badges (matches T3 client: PR icon + status pill).
 * Layout: `| PR | activity | Title` — each slot optional.
 */
export type DiscordThreadTitleBadges = {
  readonly pr: DiscordThreadPrBadgeState;
  readonly activity: DiscordThreadActivityBadgeState;
};

/**
 * @deprecated Exclusive single-slot union kept for older tests/callers.
 * Prefer `DiscordThreadTitleBadges` / dual-slot helpers.
 */
export type DiscordThreadTitleBadgeState =
  | DiscordThreadActivityBadgeState
  | DiscordThreadPrBadgeState;

/**
 * Whether Discord is actively Working (turn in progress).
 * Mirrors `isTurnInProgress` without the wake-required gate.
 */
function isDiscordThreadTurnBusy(input: {
  readonly sessionStatus: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
}): boolean {
  if (input.latestTurnState === "running") return true;
  if (
    (input.latestTurnState === null || input.latestTurnState === undefined) &&
    (input.sessionStatus === "running" || input.sessionStatus === "starting")
  ) {
    return true;
  }
  return false;
}

/**
 * Working/lifecycle column only (busy / wake-required). Independent of PR badges.
 */
export function resolveDiscordThreadActivityBadgeState(input: {
  readonly sessionStatus: string | null | undefined;
  readonly activeTurnId?: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
  readonly latestTurnCompletedAt?: string | null | undefined;
}): DiscordThreadActivityBadgeState {
  if (
    sessionNeedsWakeUp({
      sessionStatus: input.sessionStatus,
      activeTurnId: input.activeTurnId,
      latestTurnState: input.latestTurnState,
      latestTurnCompletedAt: input.latestTurnCompletedAt,
    })
  ) {
    return "wake-required";
  }
  if (
    isDiscordThreadTurnBusy({
      sessionStatus: input.sessionStatus,
      latestTurnState: input.latestTurnState,
    })
  ) {
    return "busy";
  }
  return null;
}

/**
 * @deprecated Prefer dual-slot resolve (`activity` + `pr` separately).
 * Returns activity if present, otherwise the PR state (legacy exclusive behavior).
 */
export function resolveDiscordThreadTitleBadgeState(input: {
  readonly sessionStatus: string | null | undefined;
  readonly activeTurnId?: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
  readonly latestTurnCompletedAt?: string | null | undefined;
  readonly prState: DiscordThreadPrBadgeState;
}): DiscordThreadTitleBadgeState {
  const activity = resolveDiscordThreadActivityBadgeState(input);
  if (activity !== null) return activity;
  return input.prState;
}

/** Compose PR + activity for the current snapshot. */
export function resolveDiscordThreadTitleBadges(input: {
  readonly sessionStatus: string | null | undefined;
  readonly activeTurnId?: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
  readonly latestTurnCompletedAt?: string | null | undefined;
  readonly prState: DiscordThreadPrBadgeState;
}): DiscordThreadTitleBadges {
  return {
    pr: input.prState,
    activity: resolveDiscordThreadActivityBadgeState(input),
  };
}

/** Rank used to prevent PR badge flip-flops (higher = more advanced / sticky). */
export function discordThreadTitleBadgeRank(state: DiscordThreadTitleBadgeState): number {
  switch (state) {
    case null:
      return 0;
    case "initialized":
      return 1;
    case "open":
      return 2;
    case "closed":
      return 3;
    case "merged":
      return 4;
    case "busy":
      return 50;
    case "wake-required":
      return 100;
  }
}

/**
 * Parse dual-slot badges from a Discord thread title.
 * Accepts new `PR activity Title` order and legacy single-slot / activity-first titles.
 */
export function parseDiscordThreadTitleBadges(
  title: string | null | undefined,
): DiscordThreadTitleBadges {
  if (title === null || title === undefined || title.trim() === "") {
    return { pr: null, activity: null };
  }
  let rest = title.trimStart();
  let pr: DiscordThreadPrBadgeState = null;
  let activity: DiscordThreadActivityBadgeState = null;

  const takePr = (): boolean => {
    // Open + failing checks: standalone ❌ (preferred) or legacy "❌ 🔀".
    if (/^❌\s+🔀\s+/u.test(rest) || /^❌\s+/u.test(rest)) {
      pr = "open";
      rest = rest.replace(/^❌\s+🔀\s+/u, "").replace(/^❌\s+/u, "");
      return true;
    }
    if (/^🔀\s+/u.test(rest)) {
      pr = "open";
      rest = rest.replace(/^🔀\s+/u, "");
      return true;
    }
    if (/^✔️\s+/u.test(rest) || /^✓\s+/u.test(rest)) {
      pr = "merged";
      rest = rest.replace(/^(?:✔️|✓)\s+/u, "");
      return true;
    }
    if (/^✖️\s+/u.test(rest) || /^✕\s+/u.test(rest)) {
      pr = "closed";
      rest = rest.replace(/^(?:✖️|✕)\s+/u, "");
      return true;
    }
    if (
      /^▫️\s+/u.test(rest) ||
      /^·\s+/u.test(rest) ||
      /^🍴\s+/u.test(rest) ||
      /^✅\s+/u.test(rest)
    ) {
      pr = "initialized";
      rest = rest.replace(/^(?:▫️|·|🍴|✅)\s+/u, "");
      return true;
    }
    return false;
  };

  const takeActivity = (): boolean => {
    if (/^❗\s+/u.test(rest)) {
      activity = "wake-required";
      rest = rest.replace(/^❗\s+/u, "");
      return true;
    }
    if (/^⏳\s+/u.test(rest)) {
      activity = "busy";
      rest = rest.replace(/^⏳\s+/u, "");
      return true;
    }
    return false;
  };

  // Preferred order: PR then activity. Also accept legacy activity-first.
  if (!takePr()) {
    takeActivity();
    takePr();
  } else {
    takeActivity();
  }

  return { pr, activity };
}

/**
 * Parse a single exclusive badge (legacy). Prefer `parseDiscordThreadTitleBadges`.
 * When both slots are present, returns the PR badge (activity is independent now).
 */
export function parseDiscordThreadTitleBadgeState(
  title: string | null | undefined,
): DiscordThreadTitleBadgeState {
  const badges = parseDiscordThreadTitleBadges(title);
  // Prefer PR for sticky demotion checks; fall back to activity for pure activity titles.
  if (badges.pr !== null) return badges.pr;
  return badges.activity;
}

/**
 * Whether applying PR badge `next` over `current` is allowed.
 * Never demote open/merged/closed → initialized/plain from transient missing PR data.
 * Activity badges are independent and not governed by this helper.
 */
export function shouldApplyDiscordThreadPrBadge(
  current: DiscordThreadPrBadgeState,
  next: DiscordThreadPrBadgeState,
): boolean {
  if (current === next) return true;
  if (current === "closed" && next === "open") return true;
  if (
    current === "merged" &&
    (next === "open" || next === "closed" || next === "initialized" || next === null)
  ) {
    return false;
  }
  if (
    (current === "open" || current === "merged" || current === "closed") &&
    (next === "initialized" || next === null)
  ) {
    return false;
  }
  return discordThreadTitleBadgeRank(next) >= discordThreadTitleBadgeRank(current);
}

/**
 * @deprecated Dual-slot: use `shouldApplyDiscordThreadPrBadge` for PR; activity always applies.
 * Kept for older tests that still pass exclusive states.
 */
export function shouldApplyDiscordThreadTitleBadge(
  current: DiscordThreadTitleBadgeState,
  next: DiscordThreadTitleBadgeState,
): boolean {
  if (current === next) return true;
  // Activity transitions always allowed (legacy exclusive API).
  if (
    next === "wake-required" ||
    next === "busy" ||
    current === "wake-required" ||
    current === "busy"
  ) {
    return true;
  }
  return shouldApplyDiscordThreadPrBadge(current, next);
}

/**
 * Desired Discord title after a prior plain-title settle.
 *
 * Composes optional PR + activity badges (client-style dual indicators).
 * Returns null when the settled title already matches, or when applying would
 * demote a stronger PR badge without a usable PR replacement.
 *
 * `canApplyNoPrBadge` must be true before painting ▫️ from a null PR — unknown
 * remote status is not evidence of "no PR".
 */
export function resolveSettledDiscordThreadTitleUpgrade(input: {
  readonly thread: Pick<OrchestrationThread, "branch" | "worktreePath" | "messages" | "title"> & {
    readonly session?: OrchestrationThread["session"];
    readonly latestTurn?: OrchestrationThread["latestTurn"];
  };
  readonly mirroredThreadTitle: string | null;
  readonly attemptedThreadTitle: string | null;
  readonly cachedPr:
    | (Pick<VcsStatusChangeRequest, "state"> & {
        readonly number?: number;
        readonly hasFailingChecks?: boolean;
      })
    | null
    | undefined;
  /** When false, skip upgrades that would paint ▫️ from null/unknown PR evidence. */
  readonly canApplyNoPrBadge?: boolean;
}): string | null {
  const rawPrState = threadTitleChangeRequestState(input.thread, input.cachedPr);
  const prState: DiscordThreadPrBadgeState =
    rawPrState === "initialized" && input.canApplyNoPrBadge === false ? null : rawPrState;
  const activity = resolveDiscordThreadActivityBadgeState({
    sessionStatus: input.thread.session?.status ?? null,
    activeTurnId: input.thread.session?.activeTurnId ?? null,
    latestTurnState: input.thread.latestTurn?.state ?? null,
    latestTurnCompletedAt: input.thread.latestTurn?.completedAt ?? null,
  });

  const mirroredBadges = parseDiscordThreadTitleBadges(input.mirroredThreadTitle);
  const currentBadges =
    mirroredBadges.pr !== null || mirroredBadges.activity !== null
      ? mirroredBadges
      : parseDiscordThreadTitleBadges(input.attemptedThreadTitle);

  // Sticky PR: refuse demotion; keep current PR column when next would weaken it.
  const prAllowed = shouldApplyDiscordThreadPrBadge(currentBadges.pr, prState);
  const appliedPr = prAllowed ? prState : currentBadges.pr;

  // Demotion refused and activity unchanged → leave the mirrored title alone
  // (preserves ❌ 🔀 etc. without re-decorating from a null PR cache).
  if (!prAllowed && activity === currentBadges.activity) {
    return null;
  }

  // When keeping a sticky open PR without fresh PR evidence, preserve failing-check
  // decoration already on the Discord title (standalone ❌ or legacy ❌ 🔀).
  const mirroredTitle = input.mirroredThreadTitle ?? "";
  const mirroredHasFailingOpen =
    appliedPr === "open" && (/^❌\s+🔀\s+/u.test(mirroredTitle) || /^❌\s+/u.test(mirroredTitle));
  const hasFailingChecks =
    appliedPr === "open" &&
    (input.cachedPr?.hasFailingChecks === true || (!prAllowed && mirroredHasFailingOpen));

  const desiredTitle = decorateDiscordThreadTitle(
    input.thread.title,
    {
      pr: appliedPr,
      activity,
      hasFailingChecks,
    },
    100,
  );
  // Only treat successfully mirrored titles as settled.
  if (desiredTitle === input.mirroredThreadTitle) {
    return null;
  }
  // Nothing to add and Discord title is already plain → wait for PR evidence / assistant.
  // Still allow clearing a previous activity-only badge (⏳ → plain).
  if (
    appliedPr === null &&
    activity === null &&
    currentBadges.pr === null &&
    currentBadges.activity === null
  ) {
    return null;
  }
  return desiredTitle;
}

/**
 * Temporary activity badge only (busy / wake-required). PR stays independent.
 */
export function resolveTemporaryDiscordThreadTitleBadge(input: {
  readonly sessionStatus: string | null | undefined;
  readonly activeTurnId?: string | null | undefined;
  readonly latestTurnState?: string | null | undefined;
  readonly latestTurnCompletedAt?: string | null | undefined;
}): DiscordThreadActivityBadgeState {
  return resolveDiscordThreadActivityBadgeState(input);
}

export function resolveThreadTitleChangeRequestFromStatus(
  thread: Pick<OrchestrationThread, "branch">,
  status: VcsStatusResult | null,
): VcsStatusChangeRequest | null {
  return resolveThreadChangeRequest(thread.branch, status);
}

export function resolveThreadChangeRequestLookupCwds(
  thread: Pick<OrchestrationThread, "worktreePath">,
  project: { readonly workspaceRoot: string },
): ReadonlyArray<string> {
  return [
    ...new Set(
      [thread.worktreePath, project.workspaceRoot].filter(
        (value): value is string => value !== null,
      ),
    ),
  ];
}

function formatEchoedUserMessage(message: OrchestrationThread["messages"][number]): string {
  const body = summarizeExternalUserInput(message.text);
  const attachmentCount = message.attachments?.length ?? 0;
  const attachmentNote =
    attachmentCount === 0
      ? ""
      : attachmentCount === 1
        ? "\n\n_(1 attachment included in the external input)_"
        : `\n\n_(${attachmentCount} attachments included in the external input)_`;
  if (body === "") {
    return attachmentCount === 0
      ? "_External User Input:_ _(empty message)_"
      : attachmentNote.trim();
  }
  return `_External User Input:_ ${body}${attachmentNote}`;
}

/**
 * Assistant messages that belong to the active/latest turn.
 *
 * Prefer `turnId` matching so a mid-turn steer (extra user message) does not
 * orphan pre-steer assistant progress when computing the Discord stream tip or
 * final answer. Fall back to "after last user message" when turn ids are missing.
 *
 * Critical: if we have a turn id and *no* assistants for that turn yet, return
 * empty — do **not** fall back to the previous turn's bubbles. That regression
 * re-posted the prior final answer on the next Discord Working tip / finalize.
 */
export function assistantMessagesThisTurn(
  thread: OrchestrationThread,
): ReadonlyArray<OrchestrationThread["messages"][number]> {
  const turnId = thread.latestTurn?.turnId ?? thread.session?.activeTurnId ?? null;
  const selected = assistantMessagesForDelivery({
    messages: thread.messages.map((message) => ({
      id: message.id,
      role: message.role,
      turnId: message.turnId,
      text: message.text,
    })),
    turnId,
    turnInProgress: isTurnInProgress(thread),
    hasLatestTurn: thread.latestTurn !== null && thread.latestTurn !== undefined,
    // Callers that need lastFinalized filtering use the delivery path with explicit id.
    lastFinalizedAssistantId: null,
  });
  const ids = new Set(selected.map((entry) => entry.id));
  return thread.messages.filter((message) => message.role === "assistant" && ids.has(message.id));
}

/**
 * Skip re-delivering an assistant Discord already finalized (prevents re-posting
 * the previous final answer when a new user turn starts before latestTurn advances).
 *
 * Applies even while turnInProgress: a new turn can be running while the snapshot
 * still only exposes the prior finalized bubble (time-query race).
 */
export function shouldSkipAlreadyDeliveredAssistant(input: {
  readonly assistantId: string;
  readonly lastFinalizedAssistantId: string | null;
  readonly turnInProgress: boolean;
}): boolean {
  void input.turnInProgress;
  if (input.lastFinalizedAssistantId === null) return false;
  return input.lastFinalizedAssistantId === input.assistantId;
}

/**
 * Seed Discord stream tip slots when a bridge starts/restarts.
 *
 * - **Mid-turn / rehydrate:** prior stream message ids stay **active** so we keep
 *   editing the same tip history.
 * - **Fresh Working ack (new user turn):** do **not** re-seed prior tip ids. Those
 *   messages still hold the previous turn's body; attaching them next to a blank
 *   Working.. then partially rewriting only the first chunk leaves old bubbles
 *   visible ("old tip + new answer"). Discard them so the new turn starts clean.
 */
export function seedStreamMessageIds(input: {
  readonly workingAckMessageId?: string | null | undefined;
  readonly persistedStreamMessageIds: ReadonlyArray<string>;
  /**
   * When true with a working ack, ignore persisted tip ids (new user turn).
   * When false/omitted, rehydrate mid-turn history as active tips.
   */
  readonly discardPersistedTips?: boolean;
}): {
  readonly discordMessageIds: ReadonlyArray<string>;
  readonly staleStreamMessageIds: ReadonlyArray<string>;
  /** Persisted tip ids that must be deleted from Discord for a clean new turn. */
  readonly orphanTipIdsToDelete: ReadonlyArray<string>;
} {
  const ack =
    input.workingAckMessageId !== undefined &&
    input.workingAckMessageId !== null &&
    input.workingAckMessageId.trim() !== ""
      ? input.workingAckMessageId
      : null;
  const persisted = uniqueDiscordMessageIds(input.persistedStreamMessageIds).filter(
    (id) => id !== ack,
  );
  const discardPersisted = input.discardPersistedTips === true && ack !== null;
  if (discardPersisted) {
    return {
      discordMessageIds: [ack],
      staleStreamMessageIds: [],
      orphanTipIdsToDelete: persisted,
    };
  }
  return {
    discordMessageIds: uniqueDiscordMessageIds([...persisted, ...(ack !== null ? [ack] : [])]),
    staleStreamMessageIds: [],
    orphanTipIdsToDelete: [],
  };
}

/** Concatenate this turn's assistant bubbles — for live stream tip + stream-history.md. */
function turnProgressText(thread: OrchestrationThread): string {
  return assistantMessagesThisTurn(thread)
    .map((message) => message.text.trimEnd())
    .filter((text) => text.trim() !== "")
    .join("\n\n")
    .trimEnd();
}

/**
 * User-visible final Discord answer (not the live tip).
 *
 * Multi-step agents emit many short interim bubbles ("I'm checking…") then a long
 * Findings answer. Joining them all into the "final" post looks like the in-progress
 * stream was never cleaned up. Prefer the last bubble when it's substantial; otherwise
 * the longest bubble of the turn.
 *
 * Important: a later medium-length delivery (draft PR summary, approach notes) must
 * not lose to an earlier longer Findings bubble — that buried PR links in
 * stream-history.md only (see the related Discord discussion).
 */
export function finalAnswerText(thread: OrchestrationThread): string {
  const texts = assistantMessagesThisTurn(thread)
    .map((message) => message.text.trimEnd())
    .filter((text) => text.trim() !== "");
  if (texts.length === 0) return "";
  if (texts.length === 1) return texts[0]!;

  const last = texts[texts.length - 1]!;
  const longest = texts.reduce((a, b) => (a.length >= b.length ? a : b));

  // True short trailer after a long Findings (e.g. ~120 chars after ~3200) → keep Findings.
  // Absolute cap matters: 969-char draft PR after 2811-char analysis is *not* a trailer
  // (old ratio-only check used 0.5 and discarded the PR).
  const SHORT_TRAILER_MAX_CHARS = 400;
  if (
    longest.length >= 800 &&
    last.length < SHORT_TRAILER_MAX_CHARS &&
    last.length < longest.length * 0.35
  ) {
    return longest;
  }
  // Otherwise prefer the last bubble (natural end of the turn).
  return last;
}

function allStreamIds(state: BridgeState): ReadonlyArray<string> {
  return [...new Set([...state.discordMessageIds, ...state.staleStreamMessageIds])];
}

function formatMarkdownLocalFileRefForDiscord(input: {
  readonly ref: MarkdownLocalFileRef;
  readonly githubUrlsBySrc: ReadonlyMap<string, string>;
  readonly attachedFileNames?: ReadonlySet<string> | undefined;
  readonly oversizedByName?: ReadonlySet<string> | undefined;
}): string {
  const display =
    input.ref.label.trim() !== "" ? input.ref.label : fileNameForLocalFileRef(input.ref);
  const githubUrl = input.githubUrlsBySrc.get(input.ref.target);
  if (githubUrl) {
    return `[${display}](${githubUrl})`;
  }

  const uploadName = fileNameForLocalFileRef(input.ref);
  if (input.oversizedByName?.has(uploadName)) {
    return `${display} (too large to attach in Discord)`;
  }
  if (input.attachedFileNames?.has(uploadName)) {
    return `${display} (attached below)`;
  }
  if (input.attachedFileNames || input.oversizedByName) {
    return `${display} (attachment unavailable)`;
  }
  return input.ref.match;
}

export function rewriteMarkdownLocalFileLinksForDiscord(input: {
  readonly text: string;
  readonly githubUrlsBySrc: ReadonlyMap<string, string>;
  readonly attachedFileNames?: ReadonlySet<string> | undefined;
  readonly oversizedByName?: ReadonlySet<string> | undefined;
}): string {
  return replaceMarkdownLocalFileLinks(input.text, (ref) =>
    formatMarkdownLocalFileRefForDiscord({
      ref,
      githubUrlsBySrc: input.githubUrlsBySrc,
      attachedFileNames: input.attachedFileNames,
      oversizedByName: input.oversizedByName,
    }),
  );
}

interface InlinePathCodeSpanRef {
  readonly match: string;
  readonly token: string;
}

const INLINE_PATH_CODE_SPAN =
  /`([^`\n]*\/[^`\n]*\.[A-Za-z0-9_-]{1,16}(?::\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)?)`/gu;

function extractInlinePathCodeSpanRefs(text: string): ReadonlyArray<InlinePathCodeSpanRef> {
  const refs: InlinePathCodeSpanRef[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(INLINE_PATH_CODE_SPAN)) {
    const full = match[0];
    const token = match[1]?.trim() ?? "";
    if (full === undefined || token === "" || seen.has(full)) continue;
    seen.add(full);
    refs.push({ match: full, token });
  }
  return refs;
}

const resolveGitHubLinksForInlinePathCodeSpans = (
  refs: ReadonlyArray<InlinePathCodeSpanRef>,
  cwd: string | null,
) =>
  Effect.tryPromise({
    try: async () => {
      if (cwd === null) return new Map<string, string>();
      const urls = new Map<string, string>();
      const repoContextCache = new Map();
      for (const ref of refs) {
        const url = await resolveGitHubBlobUrlForPathReference(ref.token, {
          cwd,
          repoContextCache,
        });
        if (url) {
          urls.set(ref.token, url);
        }
      }
      return urls;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to resolve GitHub links for inline path code spans").pipe(
        Effect.andThen(Effect.logError(cause)),
        Effect.as(new Map<string, string>()),
      ),
    ),
  );

export function rewriteInlinePathCodeSpansForDiscord(input: {
  readonly text: string;
  readonly githubUrlsByToken: ReadonlyMap<string, string>;
}): string {
  let out = input.text;
  const ordered = [...extractInlinePathCodeSpanRefs(input.text)].sort(
    (a, b) => b.match.length - a.match.length,
  );
  for (const ref of ordered) {
    const githubUrl = input.githubUrlsByToken.get(ref.token);
    if (!githubUrl) continue;
    out = out.split(ref.match).join(`[\`${ref.token}\`](${githubUrl})`);
  }
  return out;
}

const resolveGitHubLinksForMarkdownFiles = (refs: ReadonlyArray<MarkdownLocalFileRef>) =>
  Effect.tryPromise({
    try: async () => {
      const urls = new Map<string, string>();
      const repoContextCache = new Map();
      for (const ref of refs) {
        const url = await resolveGitHubBlobUrlForLocalPath(ref.target, { repoContextCache });
        if (url) {
          urls.set(ref.target, url);
        }
      }
      return urls;
    },
    catch: (cause) => cause,
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to resolve GitHub links for markdown files").pipe(
        Effect.andThen(Effect.logError(cause)),
        Effect.as(new Map<string, string>()),
      ),
    ),
  );

/** Text shown while streaming — drop unreadable local markdown image embeds. */
function streamDisplayText(text: string): string {
  const withoutImages = stripMarkdownImages(text, (ref) => isLocalImageSrc(ref.src));
  const stripped = stripMarkdownLocalFileLinks(withoutImages);
  const imageCount = extractMarkdownImages(text).filter((ref) => isLocalImageSrc(ref.src)).length;
  const fileCount = extractMarkdownLocalFileLinks(text).filter((ref) =>
    isLocalFileSrc(ref.src),
  ).length;
  const localCount = imageCount + fileCount;
  if (localCount === 0) return stripped;
  const note =
    localCount === 1
      ? "_(attachment will attach when done)_"
      : `_(${localCount} attachments will attach when done)_`;
  return stripped.trim() === "" ? note : `${stripped.trimEnd()}\n\n${note}`;
}

/**
 * After a tip break (user message displaced us), only stream the suffix that is
 * new relative to the frozen prefix. Prevents re-copying pre-break content below
 * the user message while keeping chronological order.
 */
export function activeStreamTipText(fullDisplayText: string, breakPrefix: string): string {
  if (breakPrefix === "") return fullDisplayText;
  if (fullDisplayText.startsWith(breakPrefix)) {
    return fullDisplayText.slice(breakPrefix.length).replace(/^\n+/u, "");
  }
  // Progress rewound / rewritten — show full text on the post-break tip.
  return fullDisplayText;
}

/**
 * When a human (or other foreign) message displaces the Working tip, freeze only what
 * Discord already showed and set the break prefix to that already-shown text.
 *
 * Bug this prevents: setting breakPrefix to the *incoming* full body (which had never
 * been painted) made post-break tipDisplayText empty — Discord kept a bare Working..
 * above the user and never showed the assistant stream after mid-turn mentions.
 */
export function planStreamTipFreezeOnDisplacement(input: {
  /** Cumulative assistant text already applied to the tip before this write. */
  readonly previousFullDisplayText: string;
  /** Active tip body after prior break prefixes (what freeze should paint). */
  readonly previousTipBody: string;
  /** Raw lastAssistantText before this write (kept for stream diffs). */
  readonly previousLastAssistantText: string;
}): {
  /** Idle freeze body for the displaced tip, or null to skip the freeze edit. */
  readonly freezeContent: string | null;
  /** Break prefix for subsequent post-break tips (already-shown display text only). */
  readonly nextBreakPrefix: string;
  /** lastAssistantText after freeze (raw text already shown). */
  readonly nextLastAssistantText: string;
} {
  const tipBody = input.previousTipBody.trim();
  // Never freeze an empty Working-only tip as a blank message; drop it and re-show
  // the current write fully on a new tip under the user message.
  if (tipBody === "" || tipBody === "…") {
    return {
      freezeContent: null,
      nextBreakPrefix: "",
      nextLastAssistantText: "",
    };
  }
  const freezeChunk =
    chunkDiscordContent(input.previousTipBody, STREAM_CHUNK_LIMIT).at(-1) ?? input.previousTipBody;
  return {
    freezeContent: stripWorkingIndicator(freezeChunk),
    nextBreakPrefix: input.previousFullDisplayText,
    nextLastAssistantText: input.previousLastAssistantText,
  };
}

/**
 * Ensure a live bridge is subscribed for this Discord channel.
 * Thin wrapper around {@link BridgeHub.ensure} (singleflight + fiber registry + cap).
 */
export const bridgeThreadToDiscord = (input: {
  readonly discordChannelId: string;
  readonly t3ThreadId: string;
  /** Pre-posted "_Working.._" message — reused as stream tip and deleted on finalize. */
  readonly workingAckMessageId?: string | null;
  /** Discord-originated T3 user message ids that may appear immediately after subscribe. */
  readonly sentDiscordUserMessageIds?: ReadonlyArray<string>;
  /** Final-only avoids progress chatter for ambient conversational turns. */
  readonly presentationMode?: DiscordBridgePresentationMode;
  readonly mode?: BridgeEnsureInput["mode"];
  readonly lastActivityAt?: string;
  readonly preferred?: boolean;
}) =>
  Effect.gen(function* () {
    const hub = yield* BridgeHub;
    yield* hub.ensure({
      discordChannelId: input.discordChannelId,
      t3ThreadId: input.t3ThreadId,
      ...(input.workingAckMessageId === undefined
        ? {}
        : { workingAckMessageId: input.workingAckMessageId }),
      ...(input.sentDiscordUserMessageIds === undefined
        ? {}
        : { sentDiscordUserMessageIds: input.sentDiscordUserMessageIds }),
      ...(input.presentationMode === undefined ? {} : { presentationMode: input.presentationMode }),
      mode: input.mode ?? "interactive",
      ...(input.lastActivityAt === undefined ? {} : { lastActivityAt: input.lastActivityAt }),
      ...(input.preferred === undefined ? {} : { preferred: input.preferred }),
    });
  });

/**
 * Bridge fiber body — owned by ResponseBridge, started via BridgeHub.
 * Exported for {@link BridgeHub} layer wiring only.
 */
export const runBridge = (
  input: BridgeEnsureInput,
  ready: Deferred.Deferred<void>,
  controlSlot: BridgeControlSlot,
) =>
  Effect.gen(function* () {
    const mode = input.mode ?? "interactive";
    yield* Effect.logInfo("Starting Discord↔T3 bridge", {
      discordChannelId: input.discordChannelId,
      t3ThreadId: input.t3ThreadId,
      mode,
      hasWorkingAck: Boolean(input.workingAckMessageId),
      presentationMode: input.presentationMode ?? "full",
    });

    const t3 = yield* T3Session;
    const rest = yield* DiscordREST;
    const discordConfig = yield* DiscordConfig.DiscordConfig;
    const links = yield* ThreadLinkStore;
    const warmCache = yield* ThreadWarmCacheStore;
    const me = yield* rest.getMyUser();
    const botUserId = me.id;
    const persistedLink = yield* links.getByDiscordThreadId(input.discordChannelId);
    const warmCacheEntry = yield* warmCache
      .load(input.t3ThreadId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    // Fresh interactive Working ack = new user turn (not mid-turn steer / rehydrate).
    // Do not re-attach previous-turn tip ids — that flashes/keeps old bodies next to
    // the new Working bubble until finalize.
    const freshWorkingTurn =
      mode === "interactive" &&
      input.workingAckMessageId !== undefined &&
      input.workingAckMessageId !== null &&
      input.workingAckMessageId !== "";
    const streamSeed = seedStreamMessageIds({
      workingAckMessageId: input.workingAckMessageId ?? null,
      persistedStreamMessageIds: persistedLink?.streamDiscordMessageIds ?? [],
      discardPersistedTips: freshWorkingTurn,
    });
    const seedLastFinalized =
      persistedLink?.lastFinalizedAssistantId ?? warmCacheEntry?.lastFinalizedAssistantId ?? null;
    const stateRef = yield* Ref.make({
      ...emptyState({
        workingAckMessageId: freshWorkingTurn ? (input.workingAckMessageId ?? null) : null,
        lastFinalizedAssistantId: seedLastFinalized,
      }),
      discordMessageIds: streamSeed.discordMessageIds,
      staleStreamMessageIds: streamSeed.staleStreamMessageIds,
      seededWorkingAckPending: freshWorkingTurn,
      taskDiscordMessageId: persistedLink?.taskDiscordMessageId ?? null,
      // Rehydrate: seed finalizedTurnId later from catch-up / adopt path using durable hints.
      sentDiscordUserMessageIds: uniqueMessageIds([
        ...(persistedLink?.sentDiscordUserMessageIds ?? []),
        ...(input.sentDiscordUserMessageIds ?? []),
      ]),
      delivery: initialDeliveryEpochState({
        epoch: freshWorkingTurn ? 1 : 0,
        phase: freshWorkingTurn ? "awaiting" : "idle",
        lastFinalizedAssistantId: seedLastFinalized,
      }),
    });
    const latestThreadRef = yield* Ref.make<OrchestrationThread | null>(null);
    const latestVcsStatusRef = yield* Ref.make<VcsStatusResult | null>(null);
    /** Sticky PR evidence — never cleared by transient null lookups (only force-refresh). */
    const stickyTitlePrRef = yield* Ref.make<StickyTitlePrEvidence | null>(null);
    /**
     * True after VCS stream delivered a real remote payload (remoteUpdated or snapshot
     * with remote). local-only events with fabricated pr:null must not count.
     */
    const vcsRemoteObservedRef = yield* Ref.make(false);
    const vcsStatusSubscriptionRef = yield* Ref.make<{
      readonly cwd: string;
      readonly fiber: Fiber.Fiber<void, unknown>;
    } | null>(null);

    const streamWriteLock = yield* Semaphore.make(1);
    const titleSyncLock = yield* Semaphore.make(1);

    // Seed title settle cache from Discord's live name so rehydrate demotion guards
    // work immediately (in-memory mirrored starts null after every bridge restart).
    yield* rest.getChannel(input.discordChannelId).pipe(
      Effect.flatMap((channel) => {
        const name = "name" in channel && typeof channel.name === "string" ? channel.name : null;
        if (name === null || name.trim() === "") return Effect.void;
        return Ref.update(stateRef, (current) => ({
          ...current,
          mirroredThreadTitle: current.mirroredThreadTitle ?? name,
          attemptedThreadTitle: current.attemptedThreadTitle ?? name,
        }));
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to seed Discord thread title from channel", {
          discordChannelId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
          cause: formatAlertCause(cause, 200),
        }),
      ),
    );
    // Mutable watermark for trim + warm cache (updated on finalize).
    const deliveredMemoryTrim = {
      lastFinalizedAssistantId: (persistedLink?.lastFinalizedAssistantId ??
        warmCacheEntry?.lastFinalizedAssistantId ??
        null) as string | null,
    };
    const projectThreadForDiscordMemory = (thread: OrchestrationThread): OrchestrationThread =>
      trimOrchestrationThreadForDiscordMemory({
        thread,
        lastFinalizedAssistantId: deliveredMemoryTrim.lastFinalizedAssistantId,
        buffer: DISCORD_DELIVERED_MESSAGE_MEMORY_BUFFER,
      });
    const persistWarmThreadCache = (thread: OrchestrationThread, sequence: number) =>
      warmCache
        .save({
          threadId: input.t3ThreadId,
          snapshotSequence: sequence,
          thread: projectThreadForDiscordMemory(thread),
          lastFinalizedAssistantId: deliveredMemoryTrim.lastFinalizedAssistantId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to persist warm thread cache", {
              t3ThreadId: input.t3ThreadId,
              sequence,
              cause: formatAlertCause(cause, 300),
            }),
          ),
          Effect.asVoid,
        );
    const persistStreamMessageIds = (ids: ReadonlyArray<string>) =>
      links.setStreamDiscordMessageIds(input.discordChannelId, uniqueDiscordMessageIds(ids));
    const persistFinalizedAssistant = (assistantId: string) =>
      Effect.gen(function* () {
        deliveredMemoryTrim.lastFinalizedAssistantId = assistantId;
        yield* links.updateBridgeHints(input.discordChannelId, {
          lastFinalizedAssistantId: assistantId,
          streamDiscordMessageIds: [],
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to persist finalize bridge hints").pipe(
            Effect.andThen(Effect.logError(cause)),
          ),
        ),
        Effect.asVoid,
      );

    // Best-effort delete of orphaned previous-turn tips so they never sit beside the
    // new Working.. as "old body + new answer".
    if (streamSeed.orphanTipIdsToDelete.length > 0) {
      yield* Effect.logInfo("Deleting leftover stream tips before fresh Working turn", {
        discordChannelId: input.discordChannelId,
        t3ThreadId: input.t3ThreadId,
        count: streamSeed.orphanTipIdsToDelete.length,
        ids: streamSeed.orphanTipIdsToDelete,
      });
      for (const id of streamSeed.orphanTipIdsToDelete) {
        yield* rest.deleteMessage(input.discordChannelId, id).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to delete leftover stream tip", {
              id,
              cause: formatAlertCause(cause, 300),
            }),
          ),
          Effect.asVoid,
        );
      }
    }

    yield* persistStreamMessageIds([
      ...streamSeed.discordMessageIds,
      ...streamSeed.staleStreamMessageIds,
    ]);
    yield* links.touch(input.discordChannelId).pipe(Effect.ignore);

    controlSlot.noteSentUserMessageIds = (ids) =>
      Ref.update(stateRef, (current) => ({
        ...current,
        sentDiscordUserMessageIds: uniqueMessageIds([...current.sentDiscordUserMessageIds, ...ids]),
      })).pipe(Effect.asVoid);

    controlSlot.adoptWorkingAckMessageId = (messageId) =>
      Effect.gen(function* () {
        if (messageId.trim() === "") return;
        // Mid-turn / new user turn on a reused bridge: switch to the new Working tip.
        // - Strip Working.. + Stop from prior tips (freeze idle) so they stay as history
        //   above the human message — do not keep editing them.
        // - Clear lastAssistantText so stream/heartbeat paint only under the new tip.
        const prior = yield* Ref.get(stateRef);
        const next = nextBridgeStateAfterAdoptWorkingAck({
          priorDiscordMessageIds: prior.discordMessageIds,
          priorStaleStreamMessageIds: prior.staleStreamMessageIds,
          workingAckMessageId: messageId,
        });
        const orphanTips = next.orphanTipsToDelete;
        const frozenBody = stripWorkingIndicator(prior.lastAssistantText).trim();
        yield* Ref.update(stateRef, (current) => ({
          ...current,
          discordMessageIds: next.discordMessageIds,
          // Orphans are frozen channel history, not live tips — drop from stale so finalize
          // does not delete the pre-steer progress bubble above the human message.
          staleStreamMessageIds: next.staleStreamMessageIds.filter(
            (id) => !orphanTips.includes(id),
          ),
          lastAssistantText: next.lastAssistantText,
          streamBreakPrefix: next.streamBreakPrefix,
          currentTurnId: next.currentTurnId,
          t3AssistantMessageId: next.t3AssistantMessageId,
          finalizedTurnId: next.finalizedTurnId,
          finalDiscordMessageIds: next.finalDiscordMessageIds,
          streamHistoryPosted: next.streamHistoryPosted,
          postedAttachmentIds: next.postedAttachmentIds,
          postedMarkdownImageSrcs: next.postedMarkdownImageSrcs,
          postedMarkdownFileSrcs: next.postedMarkdownFileSrcs,
          seededWorkingAckPending: next.seededWorkingAckPending,
          // New user turn clears prior wake-up notice so a later restart can convert again.
          wakeUpNoticePosted: false,
          // Structural: bump delivery epoch so finalized prior answer cannot re-stream.
          delivery: beginDeliveryEpoch(current.delivery),
        }));
        // Freeze prior tips: remove Working.. + Stop. Empty Working-only tips are deleted.
        if (orphanTips.length > 0) {
          const emptyOrphans: string[] = [];
          for (const id of orphanTips) {
            // Only the last active tip carried streamed prose; earlier slots were chunks.
            const isLastActiveTip =
              prior.discordMessageIds.length > 0 &&
              id === prior.discordMessageIds[prior.discordMessageIds.length - 1];
            const body = isLastActiveTip ? frozenBody : "";
            if (body === "" || body === "…") {
              emptyOrphans.push(id);
              continue;
            }
            yield* rest
              .updateMessage(input.discordChannelId, id, {
                ...idleMessageFields(body),
              })
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to freeze prior Working tip on mid-turn ack", {
                    id,
                    cause: formatAlertCause(cause, 300),
                  }).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        emptyOrphans.push(id);
                      }),
                    ),
                  ),
                ),
                Effect.asVoid,
              );
          }
          if (emptyOrphans.length > 0) {
            yield* deleteMessages(emptyOrphans).pipe(
              Effect.catchCause(Effect.logWarning),
              Effect.asVoid,
            );
          }
        }
        const state = yield* Ref.get(stateRef);
        yield* persistStreamMessageIds([
          ...state.discordMessageIds,
          ...state.staleStreamMessageIds,
        ]);
        yield* Effect.logInfo("Adopted fresh Working ack for new Discord turn", {
          t3ThreadId: input.t3ThreadId,
          workingAckMessageId: messageId,
          frozenPriorTips: orphanTips.length,
        });
      }).pipe(Effect.asVoid);

    yield* Effect.logInfo("Bridge restored persisted Discord state", {
      discordChannelId: input.discordChannelId,
      t3ThreadId: input.t3ThreadId,
      mode,
      workingAckMessageId: input.workingAckMessageId ?? null,
      persistedTaskDiscordMessageId: persistedLink?.taskDiscordMessageId ?? null,
      lastFinalizedAssistantId: persistedLink?.lastFinalizedAssistantId ?? null,
      activeStreamTips: streamSeed.discordMessageIds,
      state: summarizeBridgeStateForLog(yield* Ref.get(stateRef)),
    });
    yield* Effect.logInfo("Bridge services ready; subscribing to T3 thread", {
      botUserId,
      t3ThreadId: input.t3ThreadId,
      mode,
      activeStreamTips: streamSeed.discordMessageIds.length,
    });

    /**
     * Latest *content* message id (skip channel-name / pin system messages).
     * Limit > 1 so a burst of title renames cannot hide the Working tip.
     */
    const latestContentChannelMessage = Effect.gen(function* () {
      const messages = yield* rest.listMessages(input.discordChannelId, { limit: 15 }).pipe(
        Effect.orElseSucceed(
          () =>
            [] as ReadonlyArray<{
              readonly id: string;
              readonly type?: number | null;
              readonly author?: { readonly id?: string | null } | null;
            }>,
        ),
      );
      return pickLatestContentMessage(messages);
    });

    /** True when a human (or other non-bot-owned) *content* message is newer than the tip. */
    const isStreamTipDisplaced = (streamTipId: string | null) =>
      Effect.gen(function* () {
        if (streamTipId === null || streamTipId.trim() === "") return false;
        const latest = yield* latestContentChannelMessage;
        const state = yield* Ref.get(stateRef);
        const link = yield* links
          .getByDiscordThreadId(input.discordChannelId)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        return isStreamTipDisplacedByForeignMessage({
          latestMessageId: latest?.id ?? null,
          streamTipId,
          latestAuthorIsSelfBot: latest?.author?.id === botUserId,
          // Tasks + info pin + stream tips are bot side-channels; never freeze Working under them.
          ownedMessageIds: discordBridgeOwnedMessageIds({
            discordMessageIds: state.discordMessageIds,
            staleStreamMessageIds: state.staleStreamMessageIds,
            finalDiscordMessageIds: state.finalDiscordMessageIds,
            taskDiscordMessageId: state.taskDiscordMessageId ?? link?.taskDiscordMessageId,
            infoDiscordMessageId: link?.infoDiscordMessageId,
            streamDiscordMessageIds: link?.streamDiscordMessageIds ?? [],
          }),
        });
      });

    const deleteMessages = (ids: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        const unique = [...new Set(ids.filter((id) => id.trim() !== ""))];
        if (unique.length === 0) return;
        yield* Effect.logInfo("Deleting Discord in-progress stream messages", {
          count: unique.length,
          ids: unique,
        });
        for (const id of unique) {
          yield* rest.deleteMessage(input.discordChannelId, id).pipe(
            Effect.tap(() => Effect.logInfo("Deleted stream message", { id })),
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to delete stream message", { id }).pipe(
                Effect.andThen(Effect.logError(cause)),
              ),
            ),
            Effect.asVoid,
          );
        }
      }).pipe(Effect.asVoid);

    const clearInProgressMessages = (reason: string) =>
      streamWriteLock.withPermit(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          const ids = allStreamIds(state);
          if (ids.length === 0) return;

          yield* Effect.logInfo("Clearing Discord in-progress stream messages", {
            t3ThreadId: input.t3ThreadId,
            reason,
            count: ids.length,
            state: summarizeBridgeStateForLog(state),
          });
          yield* deleteMessages(ids);
          yield* Ref.update(stateRef, (current) => ({
            ...current,
            discordMessageIds: [],
            staleStreamMessageIds: [],
            streamBreakPrefix: "",
            seededWorkingAckPending: false,
          }));
          yield* persistStreamMessageIds([]);
        }).pipe(Effect.asVoid),
      );

    /**
     * Replace the latest Working tip with a wake-up notice + Continue button.
     * Keeps partial stream prose; removes Working.. and Stop.
     */
    const convertWorkingTipsToWakeUp = (reason: string) =>
      streamWriteLock.withPermit(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          if (state.wakeUpNoticePosted) return;
          const tipIds = allStreamIds(state);
          if (tipIds.length === 0) return;

          // Prefer the active tip slot (last discordMessageIds entry); fall back to any open id.
          const tipId =
            state.discordMessageIds.length > 0
              ? state.discordMessageIds[state.discordMessageIds.length - 1]!
              : tipIds[tipIds.length - 1]!;

          const existingContent = yield* rest.getMessage(input.discordChannelId, tipId).pipe(
            Effect.map((message) => message.content ?? ""),
            Effect.catchCause(() => Effect.succeed(state.lastAssistantText)),
          );
          const content = formatWakeUpTipContent(
            existingContent.trim() !== "" ? existingContent : state.lastAssistantText,
          );
          const fields = wakeUpMessageFields(content, input.t3ThreadId);

          const updated = yield* rest
            .updateMessage(input.discordChannelId, tipId, { ...fields })
            .pipe(Effect.result);

          let wakeMessageId = tipId;
          if (Result.isFailure(updated)) {
            yield* Effect.logWarning("Wake-up tip update failed; posting a new wake-up message", {
              t3ThreadId: input.t3ThreadId,
              tipId,
              cause: formatAlertCause(updated.failure, 300),
            });
            // Drop dead tip ids so they do not linger as "stream" state.
            yield* deleteMessages(tipIds).pipe(Effect.ignore);
            const created = yield* rest.createMessage(input.discordChannelId, { ...fields });
            wakeMessageId = created.id;
          } else {
            // Older multi-chunk stream slots: leave history, only the tip is wake-up.
            // Clear stream tracking so finalize/stop cleanup does not delete the notice.
            const otherIds = tipIds.filter((id) => id !== tipId);
            if (otherIds.length > 0) {
              // Non-tip chunks keep partial prose; strip any stale Stop via idle edit best-effort.
              for (const id of otherIds) {
                yield* rest.getMessage(input.discordChannelId, id).pipe(
                  Effect.flatMap((message) =>
                    rest.updateMessage(input.discordChannelId, id, {
                      ...idleMessageFields(stripWorkingIndicator(message.content ?? "")),
                    }),
                  ),
                  Effect.catchCause(() => Effect.void),
                );
              }
            }
          }

          yield* Ref.update(stateRef, (current) => ({
            ...current,
            discordMessageIds: [],
            staleStreamMessageIds: [],
            streamBreakPrefix: "",
            seededWorkingAckPending: false,
            wakeUpNoticePosted: true,
            adoptedInitialSnapshot: true,
            finalDiscordMessageIds: uniqueDiscordMessageIds([
              ...current.finalDiscordMessageIds,
              wakeMessageId,
            ]),
            delivery: {
              ...current.delivery,
              phase: "finalized" as const,
              streamText: "",
              settleReady: false,
            },
          }));
          yield* persistStreamMessageIds([]);
          yield* Effect.logInfo("Converted Working tip to wake-up notice", {
            t3ThreadId: input.t3ThreadId,
            reason,
            wakeMessageId,
            previousTipIds: tipIds,
          });
        }).pipe(Effect.asVoid),
      );

    const persistSentDiscordUserMessageIds = (ids: ReadonlyArray<string>) =>
      links.setSentDiscordUserMessageIds(input.discordChannelId, uniqueMessageIds(ids));

    const postExternalUserMessages = (
      messages: ReadonlyArray<OrchestrationThread["messages"][number]>,
    ) =>
      Effect.gen(function* () {
        for (const message of messages) {
          yield* rest.createMessage(input.discordChannelId, {
            content: formatEchoedUserMessage(message),
          });
        }
      }).pipe(Effect.asVoid);

    const postOrEditTasks = (content: string, taskKey: string) =>
      Effect.gen(function* () {
        const state = yield* Ref.get(stateRef);
        const action = resolveTaskMessageAction({
          taskDiscordMessageId: state.taskDiscordMessageId,
          lastTasksKey: state.lastTasksKey,
          nextTasksKey: taskKey,
        });
        if (action === "skip") return;

        if (action === "update" && state.taskDiscordMessageId !== null) {
          yield* rest.updateMessage(input.discordChannelId, state.taskDiscordMessageId, {
            content,
          });
          yield* Ref.update(stateRef, (current) => ({
            ...current,
            lastTasksKey: taskKey,
          }));
          return;
        }

        const created = yield* rest.createMessage(input.discordChannelId, {
          content,
        });
        yield* Ref.update(stateRef, (current) => ({
          ...current,
          taskDiscordMessageId: created.id,
          lastTasksKey: taskKey,
        }));
        yield* links.setTaskDiscordMessageId(input.discordChannelId, created.id);
      }).pipe(Effect.asVoid);

    /**
     * Download T3 chat image attachments into raw bytes for Discord multipart upload.
     */
    const loadAttachmentFiles = (
      attachments: ReadonlyArray<ChatImageAttachment>,
      maxFiles: number,
    ) =>
      Effect.gen(function* () {
        const limited = attachments.slice(0, Math.max(0, maxFiles));
        const files: DiscordUploadFile[] = [];
        for (const attachment of limited) {
          const file = yield* Effect.gen(function* () {
            const url = yield* t3.createAttachmentUrl(attachment.id);
            const response = yield* Effect.tryPromise({
              try: () => globalThis.fetch(url),
              catch: (cause) => cause,
            });
            if (!response.ok) {
              yield* Effect.logWarning(
                `Attachment download failed (${response.status}) for ${attachment.id}`,
              );
              return null;
            }
            const buffer = yield* Effect.tryPromise({
              try: () => response.arrayBuffer(),
              catch: (cause) => cause,
            });
            return {
              name: attachment.name,
              mimeType: attachment.mimeType,
              data: new Uint8Array(buffer),
            } satisfies DiscordUploadFile;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError(cause).pipe(Effect.as(null as DiscordUploadFile | null)),
            ),
          );
          if (file !== null) files.push(file);
        }
        return files as ReadonlyArray<DiscordUploadFile>;
      });

    /**
     * Load Codex/ACP markdown image embeds as real binary files for Discord multipart.
     * 1) Local disk (after stripping attachment:/file://)
     * 2) Fallback: T3 assets.createUrl (workspace-file) + HTTP fetch
     */
    const loadMarkdownImageFiles = (
      refs: ReadonlyArray<MarkdownImageRef>,
      alreadyPosted: ReadonlyArray<string>,
      maxFiles: number,
    ) =>
      Effect.gen(function* () {
        const posted = new Set(alreadyPosted);
        // Deduplicate by normalized filesystem path so html+link of same file upload once.
        const pendingByPath = new Map<string, MarkdownImageRef>();
        for (const ref of refs) {
          if (!isLocalImageSrc(ref.rawSrc || ref.src)) continue;
          if (posted.has(ref.src) || pendingByPath.has(ref.src)) continue;
          pendingByPath.set(ref.src, ref);
        }
        const pending = [...pendingByPath.values()].slice(0, Math.max(0, maxFiles));
        const files: DiscordUploadFile[] = [];
        const loadedSrcs: string[] = [];
        for (const ref of pending) {
          // Grok emits session-relative `images/1.jpg`; Codex usually absolute.
          // Resolve before disk read / assets so relative embeds actually upload.
          const resolved =
            resolveImagePathOnDisk(ref.src) ??
            resolveImagePathOnDisk(ref.rawSrc) ??
            assertFilesystemPath(ref.src);
          const filePath = resolved;
          const name = fileNameForImageRef(ref);
          const mime = guessImageMimeType(filePath);

          yield* Effect.logInfo("Loading markdown image for Discord multipart", {
            rawSrc: ref.rawSrc,
            filePath,
            resolvedFrom: ref.src,
            name,
          });

          const fromDisk = yield* Effect.tryPromise({
            try: async () => {
              const safePath = assertFilesystemPath(filePath);
              const bytes = await NodeFSP.readFile(safePath);
              return {
                name,
                mimeType: mime,
                data: new Uint8Array(bytes),
              } satisfies DiscordUploadFile;
            },
            catch: (cause) => cause,
          }).pipe(Effect.option);

          if (fromDisk._tag === "Some") {
            files.push(fromDisk.value);
            loadedSrcs.push(ref.src);
            yield* Effect.logInfo("Loaded image from disk for Discord", {
              filePath,
              bytes: fromDisk.value.data.byteLength,
            });
            continue;
          }

          const fromAsset = yield* Effect.gen(function* () {
            // Assets API needs a workspace-relative path; absolute agent paths rarely work.
            // Prefer original relative src for workspace lookup when we failed disk resolve.
            const assetPath = assertFilesystemPath(ref.src);
            const url = yield* t3.createWorkspaceFileUrl({
              threadId: input.t3ThreadId as ThreadId,
              path: assetPath,
            });
            const response = yield* Effect.tryPromise({
              try: () => globalThis.fetch(url),
              catch: (cause) => cause,
            });
            if (!response.ok) {
              yield* Effect.logWarning(
                `Asset image download failed (${response.status}) for ${assetPath}`,
              );
              return null as DiscordUploadFile | null;
            }
            const buffer = yield* Effect.tryPromise({
              try: () => response.arrayBuffer(),
              catch: (cause) => cause,
            });
            return {
              name,
              mimeType: mime,
              data: new Uint8Array(buffer),
            } satisfies DiscordUploadFile;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  `Could not load markdown image for Discord (disk+asset): raw=${ref.rawSrc} path=${filePath}`,
                );
                yield* Effect.logError(cause);
                return null as DiscordUploadFile | null;
              }),
            ),
          );

          if (fromAsset !== null) {
            files.push(fromAsset);
            loadedSrcs.push(ref.src);
            yield* Effect.logInfo("Loaded image via T3 assets for Discord", {
              filePath,
              bytes: fromAsset.data.byteLength,
            });
          }
        }
        return {
          files: files as ReadonlyArray<DiscordUploadFile>,
          loadedSrcs: loadedSrcs as ReadonlyArray<string>,
        };
      });

    const loadMarkdownLinkedFiles = (
      refs: ReadonlyArray<MarkdownLocalFileRef>,
      alreadyPosted: ReadonlyArray<string>,
      maxFiles: number,
    ) =>
      Effect.gen(function* () {
        const posted = new Set(alreadyPosted);
        const pendingByPath = new Map<string, MarkdownLocalFileRef>();
        for (const ref of refs) {
          if (!isLocalFileSrc(ref.rawSrc || ref.src)) continue;
          if (posted.has(ref.src) || pendingByPath.has(ref.src)) continue;
          pendingByPath.set(ref.src, ref);
        }
        const pending = [...pendingByPath.values()].slice(0, Math.max(0, maxFiles));
        const files: DiscordUploadFile[] = [];
        const loadedSrcs: string[] = [];
        for (const ref of pending) {
          const filePath = assertFilesystemFilePath(ref.src);
          const name = fileNameForLocalFileRef(ref);
          const mime = guessFileMimeType(filePath);

          yield* Effect.logInfo("Loading markdown file for Discord multipart", {
            rawSrc: ref.rawSrc,
            filePath,
            name,
          });

          const fromDisk = yield* Effect.tryPromise({
            try: async () => {
              const safePath = assertFilesystemFilePath(filePath);
              const bytes = await NodeFSP.readFile(safePath);
              return {
                name,
                mimeType: mime,
                data: new Uint8Array(bytes),
              } satisfies DiscordUploadFile;
            },
            catch: (cause) => cause,
          }).pipe(Effect.option);

          if (fromDisk._tag === "Some") {
            files.push(fromDisk.value);
            loadedSrcs.push(ref.src);
            continue;
          }

          const fromAsset = yield* Effect.gen(function* () {
            const assetPath = assertFilesystemFilePath(ref.src);
            const url = yield* t3.createWorkspaceFileUrl({
              threadId: input.t3ThreadId as ThreadId,
              path: assetPath,
            });
            const response = yield* Effect.tryPromise({
              try: () => globalThis.fetch(url),
              catch: (cause) => cause,
            });
            if (!response.ok) {
              yield* Effect.logWarning(
                `Asset file download failed (${response.status}) for ${assetPath}`,
              );
              return null as DiscordUploadFile | null;
            }
            const buffer = yield* Effect.tryPromise({
              try: () => response.arrayBuffer(),
              catch: (cause) => cause,
            });
            return {
              name,
              mimeType: mime,
              data: new Uint8Array(buffer),
            } satisfies DiscordUploadFile;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning(
                  `Could not load markdown file for Discord (disk+asset): raw=${ref.rawSrc} path=${filePath}`,
                );
                yield* Effect.logError(cause);
                return null as DiscordUploadFile | null;
              }),
            ),
          );

          if (fromAsset !== null) {
            files.push(fromAsset);
            loadedSrcs.push(ref.src);
          }
        }
        return {
          files: files as ReadonlyArray<DiscordUploadFile>,
          loadedSrcs: loadedSrcs as ReadonlyArray<string>,
        };
      });

    const splitFilesForDiscordUpload = (files: ReadonlyArray<DiscordUploadFile>) => {
      const batches: DiscordUploadFile[][] = [];
      const oversized: DiscordUploadFile[] = [];
      let current: DiscordUploadFile[] = [];
      let currentBytes = 0;

      for (const file of files) {
        if (file.data.byteLength > DISCORD_CONSERVATIVE_UPLOAD_LIMIT_BYTES) {
          oversized.push(file);
          continue;
        }
        const nextTooLarge =
          current.length > 0 &&
          currentBytes + file.data.byteLength > DISCORD_CONSERVATIVE_UPLOAD_LIMIT_BYTES;
        const nextTooMany = current.length >= DISCORD_MAX_FILES_PER_MESSAGE;
        if (nextTooLarge || nextTooMany) {
          batches.push(current);
          current = [];
          currentBytes = 0;
        }
        current.push(file);
        currentBytes += file.data.byteLength;
      }

      if (current.length > 0) {
        batches.push(current);
      }

      return {
        batches: batches as ReadonlyArray<ReadonlyArray<DiscordUploadFile>>,
        oversized: oversized as ReadonlyArray<DiscordUploadFile>,
      };
    };

    /**
     * Create a Discord message. Binary files use native multipart FormData + fetch
     * (HTTP/1.1). dfx `withFiles` goes through Effect/Undici HTTP2 and dies with
     * NGHTTP2_PROTOCOL_ERROR on ~1MB payloads — never updateMessage with files.
     *
     * Empty contentLength is expected for image-only replies after markdown embeds
     * are stripped; Discord allows content="" when files are present.
     */
    const createMessageWithFiles = (content: string, files: ReadonlyArray<DiscordUploadFile>) =>
      Effect.gen(function* () {
        const body = stripWorkingIndicator(content);
        if (files.length === 0) {
          const message = yield* rest.createMessage(input.discordChannelId, {
            content: body.trim() !== "" ? body : "\u200b",
          });
          return { id: message.id as string };
        }

        yield* Effect.logInfo("Discord multipart createMessage (native FormData)", {
          contentLen: body.length,
          imageOnly: body.trim() === "",
          files: files.map((f) => ({
            name: f.name,
            mimeType: f.mimeType,
            bytes: f.data.byteLength,
          })),
        });

        const message = yield* Effect.tryPromise({
          try: () =>
            createMessageWithAttachments({
              baseUrl: discordConfig.rest.baseUrl,
              botToken: Redacted.value(discordConfig.token),
              channelId: input.discordChannelId,
              content: body,
              files,
            }),
          catch: (cause) =>
            cause instanceof DiscordUploadError
              ? cause
              : new DiscordUploadError(cause instanceof Error ? cause.message : String(cause)),
        });

        yield* Effect.logInfo("Discord multipart createMessage ok", {
          messageId: message.id,
          fileCount: files.length,
        });
        return { id: message.id };
      });

    const currentTurnToolCallCount = (thread: OrchestrationThread | null): number => {
      if (thread === null) return 0;
      // Latest in-progress work segment only (after last settled assistant for this turn).
      return countTurnToolCalls(
        thread.activities,
        thread.latestTurn?.turnId ?? null,
        thread.messages.map((message) => ({
          role: message.role,
          turnId: message.turnId,
          streaming: message.streaming,
          createdAt: message.createdAt,
        })),
      );
    };

    /**
     * In-progress stream only:
     * - edit latest bot message while it remains the channel tip and under 2000 chars
     * - if someone posts after us, open a new message (old tip stays tracked for delete)
     * - tip ends with italic _Working.._ (optional · N tool calls on the same line)
     *
     * On turn complete: stream messages are deleted, archived as stream-history.md,
     * and the final answer is posted as normal Discord message content (+ real image files).
     */
    const postOrEditAssistantUnlocked = (args: {
      readonly turnId: string | null;
      readonly t3MessageId: string;
      readonly text: string;
      readonly streaming: boolean;
      readonly images: ReadonlyArray<ChatImageAttachment>;
      readonly worktreePath: string | null;
    }) =>
      Effect.gen(function* () {
        const { turnId, t3MessageId, text, streaming, images, worktreePath } = args;
        const state = yield* Ref.get(stateRef);
        const reopensFinalizedDelivery = shouldReopenFinalizedDelivery({
          finalizedTurnId: state.finalizedTurnId,
          currentAssistantMessageId: state.t3AssistantMessageId,
          turnId,
          nextAssistantMessageId: t3MessageId,
        });

        if (
          state.currentTurnId === turnId &&
          state.t3AssistantMessageId === t3MessageId &&
          state.lastAssistantText === text &&
          (state.discordMessageIds.length > 0 || state.finalDiscordMessageIds.length > 0) &&
          streaming
        ) {
          return;
        }

        const markdownImages = extractMarkdownImages(text).filter((ref) =>
          isLocalImageSrc(ref.src),
        );
        const pendingMarkdown = markdownImages.filter(
          (ref) => !state.postedMarkdownImageSrcs.includes(ref.src),
        );
        const markdownFiles = extractMarkdownLocalFileLinks(text).filter((ref) =>
          isLocalFileSrc(ref.src),
        );
        const pendingMarkdownFiles = markdownFiles.filter(
          (ref) => !state.postedMarkdownFileSrcs.includes(ref.src),
        );

        // Finished turn with same text already finalized and attachments posted — skip.
        if (
          !streaming &&
          !reopensFinalizedDelivery &&
          state.finalizedTurnId === turnId &&
          state.lastAssistantText === text &&
          unpostedAttachments(images, state.postedAttachmentIds).length === 0 &&
          pendingMarkdown.length === 0 &&
          pendingMarkdownFiles.length === 0
        ) {
          return;
        }

        // After finalize, only late-arriving images are handled (no more stream edits).
        if (!streaming && !reopensFinalizedDelivery && state.finalizedTurnId === turnId) {
          yield* finalizeAssistantMessage({
            turnId,
            t3MessageId,
            text,
            images,
            streamHistoryText: "",
            worktreePath,
          });
          return;
        }

        // Structural gate: never stream after this epoch finalized (avoids final+Working mess).
        if (streaming && state.delivery.phase === "finalized" && !reopensFinalizedDelivery) {
          yield* Effect.logInfo("Skipping stream write; delivery epoch already finalized", {
            t3ThreadId: input.t3ThreadId,
            turnId,
            t3MessageId,
            epoch: state.delivery.epoch,
          });
          return;
        }

        if (streaming) {
          const startsNewDelivery = startsNewStreamDelivery({
            currentTurnId: state.currentTurnId,
            nextTurnId: turnId,
            reopensFinalizedDelivery,
            seededWorkingAckPending: state.seededWorkingAckPending,
          });

          // Multi-step agents open a new assistant id per bubble while the turn runs.
          // Keep the same Discord tip(s) and edit them — never delete/recreate mid-turn
          // while we still own the channel tip.
          // Working.. ack (if seeded) is already in discordMessageIds.
          // On a new delivery, only keep the newest tip slot (the Working ack) so we never
          // try to edit prior-turn message ids (Discord 10008 Unknown Message).
          const tipSlots = activeStreamTipIdsForDelivery({
            startsNewDelivery,
            discordMessageIds: state.discordMessageIds,
            staleStreamMessageIds: state.staleStreamMessageIds,
          });
          let discordMessageIds: readonly string[] = [...tipSlots.discordMessageIds];
          let staleStreamMessageIds: readonly string[] = [...tipSlots.staleStreamMessageIds];
          let streamBreakPrefix = startsNewDelivery ? "" : state.streamBreakPrefix;
          // Force a full content rewrite when the tracked assistant id changes so a
          // shorter replacement bubble doesn't leave stale suffix text.
          let lastText = startsNewDelivery ? "" : state.lastAssistantText;

          const fullDisplayText = streamDisplayText(text);
          const previousFullDisplayText = streamDisplayText(lastText);

          // If a *foreign* message is under us (human reply), freeze the tip in place —
          // do NOT delete (that reorders history) and do NOT re-copy its body after the
          // user message. Later content only appears as a post-break tip.
          // Bot-owned side posts (live Tasks / approvals / info pin) must NOT break the
          // tip — they steal channel-tip ownership and left Discord on empty Working..
          // while T3 streamed intermediate prose.
          if (discordMessageIds.length > 0) {
            const tipId = discordMessageIds[discordMessageIds.length - 1] ?? null;
            if (tipId !== null && (yield* isStreamTipDisplaced(tipId))) {
              const previousTipBody = activeStreamTipText(
                previousFullDisplayText,
                streamBreakPrefix,
              );
              const freezePlan = planStreamTipFreezeOnDisplacement({
                previousFullDisplayText,
                previousTipBody,
                previousLastAssistantText: lastText,
              });
              if (freezePlan.freezeContent !== null) {
                yield* rest
                  .updateMessage(input.discordChannelId, tipId, {
                    ...idleMessageFields(freezePlan.freezeContent),
                  })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Failed to freeze displaced stream tip", {
                        id: tipId,
                        cause: formatAlertCause(cause, 300),
                      }),
                    ),
                    Effect.asVoid,
                  );
              }
              yield* Effect.logInfo(
                "Discord stream tip lost channel-tip ownership; freezing in place",
                {
                  t3ThreadId: input.t3ThreadId,
                  assistantId: t3MessageId,
                  frozenDiscordMessageId: tipId,
                  // Prefix is *already-shown* text only — never the in-flight body, or mid-turn
                  // human replies hide everything under an empty Working tip below the user.
                  breakPrefixLen: freezePlan.nextBreakPrefix.length,
                  hadFrozenProse: freezePlan.freezeContent !== null,
                },
              );
              // Frozen messages stay visible above the user message; finalize deletes them.
              staleStreamMessageIds = uniqueDiscordMessageIds([
                ...staleStreamMessageIds,
                ...discordMessageIds,
              ]);
              discordMessageIds = [];
              streamBreakPrefix = freezePlan.nextBreakPrefix;
              // Keep lastText as what was already streamed so the next post-break write
              // diffs against shown content, not against the never-posted full body.
              lastText = freezePlan.nextLastAssistantText;
            }
          }

          const tipDisplayText = activeStreamTipText(fullDisplayText, streamBreakPrefix);
          const previousTipDisplayText = activeStreamTipText(
            previousFullDisplayText,
            streamBreakPrefix,
          );

          // After a tip break, always keep a post-break Working tip for liveness even when
          // the model is only running tools (no new prose yet). Previously we returned
          // early with empty suffix → frozen tip above the user and *no* Working below,
          // so Discord looked dead while T3 was still busy.
          const desiredChunks =
            tipDisplayText.trim() === ""
              ? ([""] as string[])
              : chunkDiscordContent(tipDisplayText, STREAM_CHUNK_LIMIT);

          // Preserve tool-call progress on the Working line when stream text changes so the
          // 10s heartbeat is not the only place the count can appear mid-prose.
          const latestForTools = yield* Ref.get(latestThreadRef);
          const toolCallCount = currentTurnToolCallCount(latestForTools);

          for (let index = 0; index < desiredChunks.length; index += 1) {
            const chunk = desiredChunks[index] ?? "";
            const existingId = discordMessageIds[index] ?? null;
            const isLastChunk = index === desiredChunks.length - 1;
            const content = formatInProgressChunk(
              chunk,
              isLastChunk,
              DISCORD_LIMIT,
              2,
              toolCallCount,
            );

            if (existingId !== null) {
              const previousChunks = chunkDiscordContent(
                previousTipDisplayText,
                STREAM_CHUNK_LIMIT,
              );
              const previousChunk = previousChunks[index] ?? "";
              const previousIsLastChunk = index === previousChunks.length - 1;
              const contentChanged = previousChunk !== chunk;
              const stopButtonVisibilityChanged = previousIsLastChunk !== isLastChunk;

              if (contentChanged || isLastChunk || stopButtonVisibilityChanged) {
                // Tip ownership is checked at the start of the update; here we only edit.
                // After bot restart, durable tip ids may point at deleted messages — recreate.
                const fields = isLastChunk
                  ? workingMessageFields(content, input.t3ThreadId)
                  : idleMessageFields(content);
                const updated = yield* rest
                  .updateMessage(input.discordChannelId, existingId, { ...fields })
                  .pipe(Effect.result);
                if (
                  shouldRecreateStreamTipOnUpdateFailure({
                    turnInProgress: true,
                    updateFailed: Result.isFailure(updated),
                  })
                ) {
                  yield* Effect.logWarning(
                    "Stream tip update failed (likely deleted on restart); creating replacement",
                    {
                      t3ThreadId: input.t3ThreadId,
                      deadTipId: existingId,
                      cause: formatAlertCause(
                        Result.isFailure(updated) ? updated.failure : "unknown",
                        300,
                      ),
                    },
                  );
                  staleStreamMessageIds = uniqueDiscordMessageIds([
                    ...staleStreamMessageIds,
                    existingId,
                  ]);
                  const created = yield* rest.createMessage(input.discordChannelId, {
                    ...fields,
                  });
                  discordMessageIds = [
                    ...discordMessageIds.slice(0, index),
                    created.id,
                    ...discordMessageIds.slice(index + 1),
                  ];
                }
              }
            } else {
              const created = yield* rest.createMessage(input.discordChannelId, {
                ...(isLastChunk
                  ? workingMessageFields(content, input.t3ThreadId)
                  : idleMessageFields(content)),
              });
              discordMessageIds = [...discordMessageIds, created.id];
            }
          }

          // Messages beyond the new post-break chunk count are obsolete (shorter rewrite).
          // Mark stale for finalize cleanup — do not delete mid-turn (preserves order).
          if (discordMessageIds.length > desiredChunks.length) {
            const extra = discordMessageIds.slice(desiredChunks.length);
            staleStreamMessageIds = uniqueDiscordMessageIds([...staleStreamMessageIds, ...extra]);
            discordMessageIds = discordMessageIds.slice(0, desiredChunks.length);
          }

          yield* Ref.update(stateRef, (current) => ({
            ...current,
            currentTurnId: turnId,
            t3AssistantMessageId: t3MessageId,
            lastAssistantText: text,
            discordMessageIds,
            staleStreamMessageIds,
            streamBreakPrefix,
            postedAttachmentIds: startsNewDelivery ? [] : current.postedAttachmentIds,
            postedMarkdownImageSrcs: startsNewDelivery ? [] : current.postedMarkdownImageSrcs,
            postedMarkdownFileSrcs: startsNewDelivery ? [] : current.postedMarkdownFileSrcs,
            finalizedTurnId: startsNewDelivery ? null : current.finalizedTurnId,
            finalDiscordMessageIds: startsNewDelivery ? [] : current.finalDiscordMessageIds,
            streamHistoryPosted: startsNewDelivery ? false : current.streamHistoryPosted,
            seededWorkingAckPending: false,
          }));
          yield* persistStreamMessageIds([...discordMessageIds, ...staleStreamMessageIds]);
          return;
        }

        // Turn finished — archive stream tips as stream-history.md, post final answer,
        // delete in-progress messages. stream-history is ONLY produced here (not mid-turn).
        const prior = yield* Ref.get(stateRef);
        const streamHistoryText = shouldArchiveStreamHistory({
          presentationMode: input.presentationMode ?? "full",
          hasStreamMessages: allStreamIds(prior).length > 0,
        })
          ? prior.lastAssistantText
          : "";

        yield* Ref.update(stateRef, (current) => {
          // Keep tip ids for deletion; reset attachment bookkeeping only if this is a
          // new assistant id after a prior finalize (should be rare with turn-scoped stream).
          const freshAfterFinalize = shouldReopenFinalizedDelivery({
            finalizedTurnId: current.finalizedTurnId,
            currentAssistantMessageId: current.t3AssistantMessageId,
            turnId,
            nextAssistantMessageId: t3MessageId,
          });
          return {
            ...current,
            currentTurnId: turnId,
            t3AssistantMessageId: t3MessageId,
            lastAssistantText: text,
            discordMessageIds: current.discordMessageIds,
            staleStreamMessageIds: current.staleStreamMessageIds,
            postedAttachmentIds: freshAfterFinalize ? [] : current.postedAttachmentIds,
            postedMarkdownImageSrcs: freshAfterFinalize ? [] : current.postedMarkdownImageSrcs,
            postedMarkdownFileSrcs: freshAfterFinalize ? [] : current.postedMarkdownFileSrcs,
            finalizedTurnId: freshAfterFinalize ? null : current.finalizedTurnId,
            finalDiscordMessageIds: freshAfterFinalize ? [] : current.finalDiscordMessageIds,
            streamHistoryPosted: freshAfterFinalize ? false : current.streamHistoryPosted,
            seededWorkingAckPending: false,
          };
        });
        yield* finalizeAssistantMessage({
          turnId,
          t3MessageId,
          text,
          images,
          streamHistoryText,
          worktreePath,
        });
      }).pipe(Effect.asVoid);

    const postOrEditAssistant = (args: Parameters<typeof postOrEditAssistantUnlocked>[0]) => {
      // Finalize has its own inner timeouts; stream path needs an outer cap so a
      // hung listMessages/updateMessage cannot pin delivery + streamWrite locks.
      const write = postOrEditAssistantUnlocked(args);
      if (!args.streaming) {
        return streamWriteLock.withPermit(write);
      }
      return streamWriteLock.withPermit(
        Effect.gen(function* () {
          const outcome = yield* write.pipe(
            Effect.timeout(BRIDGE_STREAM_DISCORD_TIMEOUT),
            Effect.result,
          );
          if (Result.isFailure(outcome)) {
            yield* Effect.logError("Discord stream tip write failed or timed out", {
              t3ThreadId: input.t3ThreadId,
              turnId: args.turnId,
              t3MessageId: args.t3MessageId,
              timeout: BRIDGE_STREAM_DISCORD_TIMEOUT,
              cause: formatAlertCause(outcome.failure, 300),
            });
          }
        }),
      );
    };

    /**
     * Final delivery for a completed assistant turn:
     * 1. Post the final answer as normal Discord message content (chunked if needed)
     * 2. Attach stream-history.md + chat image attachments + local markdown images as files
     * 3. Delete the in-progress stream messages so only the final answer remains visible
     */
    const finalizeAssistantMessage = (args: {
      readonly turnId: string | null;
      readonly t3MessageId: string;
      readonly text: string;
      readonly images: ReadonlyArray<ChatImageAttachment>;
      readonly streamHistoryText: string;
      readonly worktreePath: string | null;
    }) =>
      Effect.gen(function* () {
        const { turnId, t3MessageId, text, images, streamHistoryText, worktreePath } = args;
        const state = yield* Ref.get(stateRef);
        // Turn-id mismatch used to hard-return with no log, which left Working.. tips
        // stranded when catch-up/rehydrate raced a mid-turn id reset. Prefer finishing
        // delivery when we still have open tips or non-empty final text.
        if (state.currentTurnId !== turnId) {
          const openTips = allStreamIds(state).length;
          const hasText = text.trim() !== "";
          if (openTips === 0 && !hasText) {
            yield* Effect.logInfo("Skipping finalize: turn id mismatch and nothing to post", {
              t3ThreadId: input.t3ThreadId,
              expectedTurnId: turnId,
              currentTurnId: state.currentTurnId,
              t3MessageId,
            });
            return;
          }
          yield* Effect.logWarning("Finalize turn id mismatch; proceeding to clear tips / post", {
            t3ThreadId: input.t3ThreadId,
            expectedTurnId: turnId,
            currentTurnId: state.currentTurnId,
            t3MessageId,
            openTips,
            textLen: text.length,
          });
        }

        const pendingImages = unpostedAttachments(images, state.postedAttachmentIds);
        const markdownRefs = extractMarkdownImages(text).filter((ref) => isLocalImageSrc(ref.src));
        const pendingMarkdown = markdownRefs.filter(
          (ref) => !state.postedMarkdownImageSrcs.includes(ref.src),
        );
        const markdownFileRefs = extractMarkdownLocalFileLinks(text).filter((ref) =>
          isLocalFileSrc(ref.src),
        );
        const githubUrlsBySrc = yield* resolveGitHubLinksForMarkdownFiles(markdownFileRefs);
        const pendingMarkdownFiles = markdownFileRefs.filter(
          (ref) => !state.postedMarkdownFileSrcs.includes(ref.src) && !githubUrlsBySrc.has(ref.src),
        );
        const durableLink = yield* links
          .getByDiscordThreadId(input.discordChannelId)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        const alreadyFinalized = isAssistantAlreadyFinalizedOnDiscord({
          assistantId: t3MessageId,
          finalizedTurnId: state.finalizedTurnId,
          turnId,
          lastFinalizedAssistantId: state.delivery.lastFinalizedAssistantId,
          durableLastFinalizedAssistantId: durableLink?.lastFinalizedAssistantId ?? null,
        });

        // Nothing left to do.
        if (
          alreadyFinalized &&
          pendingImages.length === 0 &&
          pendingMarkdown.length === 0 &&
          pendingMarkdownFiles.length === 0
        ) {
          // Still clear any leftover Working tips if durable finalize outran tip cleanup.
          if (allStreamIds(state).length > 0) {
            yield* deleteMessages(allStreamIds(state));
            yield* Ref.update(stateRef, (current) => ({
              ...current,
              discordMessageIds: [],
              staleStreamMessageIds: [],
              streamBreakPrefix: "",
              finalizedTurnId: turnId ?? current.finalizedTurnId,
              seededWorkingAckPending: false,
            }));
            yield* persistStreamMessageIds([]);
          }
          return;
        }

        // Late images after a prior finalize: must be a *new* createMessage with files.
        if (
          alreadyFinalized &&
          (pendingImages.length > 0 ||
            pendingMarkdown.length > 0 ||
            pendingMarkdownFiles.length > 0)
        ) {
          const imageFiles = yield* loadAttachmentFiles(
            pendingImages,
            DISCORD_MAX_FILES_PER_MESSAGE,
          );
          const slotsLeft = DISCORD_MAX_FILES_PER_MESSAGE - imageFiles.length;
          const mdLoaded = yield* loadMarkdownImageFiles(
            pendingMarkdown,
            state.postedMarkdownImageSrcs,
            slotsLeft,
          );
          const fileSlotsLeft = slotsLeft - mdLoaded.files.length;
          const linkedFilesLoaded = yield* loadMarkdownLinkedFiles(
            pendingMarkdownFiles,
            state.postedMarkdownFileSrcs,
            fileSlotsLeft,
          );
          const files = [...imageFiles, ...mdLoaded.files, ...linkedFilesLoaded.files];
          if (files.length === 0) return;
          const created = yield* createMessageWithFiles("", files);
          const postedFromFiles = pendingImages
            .slice(0, imageFiles.length)
            .map((entry) => entry.id);
          yield* Ref.update(stateRef, (current) => ({
            ...current,
            postedAttachmentIds: [...new Set([...current.postedAttachmentIds, ...postedFromFiles])],
            postedMarkdownImageSrcs: [
              ...new Set([...current.postedMarkdownImageSrcs, ...mdLoaded.loadedSrcs]),
            ],
            postedMarkdownFileSrcs: [
              ...new Set([...current.postedMarkdownFileSrcs, ...linkedFilesLoaded.loadedSrcs]),
            ],
            finalDiscordMessageIds: [...current.finalDiscordMessageIds, created.id],
          }));
          return;
        }

        // Archive in-progress stream as .md only when it has intermediate progress beyond the
        // final answer (not a lone Working.. tip, and not message body === stream body).
        const historySource = stripWorkingIndicator(
          streamHistoryText.trim() !== ""
            ? streamHistoryText
            : state.t3AssistantMessageId === t3MessageId
              ? state.lastAssistantText
              : "",
        );
        const hadStreamMessages = allStreamIds(state).length > 0;
        const finalSource = stripWorkingIndicator(text);
        const shouldAttachStreamHistory =
          !state.streamHistoryPosted &&
          hadStreamMessages &&
          streamHistoryHasAdditionalContent(historySource, finalSource);

        let streamHistoryTextBody: string | null = null;
        if (shouldAttachStreamHistory) {
          const historyMarkdownFiles = extractMarkdownLocalFileLinks(historySource).filter((ref) =>
            isLocalFileSrc(ref.src),
          );
          const historyGitHubUrlsBySrc =
            yield* resolveGitHubLinksForMarkdownFiles(historyMarkdownFiles);
          const rewrittenHistorySource = rewriteMarkdownLocalFileLinksForDiscord({
            text: historySource,
            githubUrlsBySrc: historyGitHubUrlsBySrc,
          });
          const historyInlineGitHubUrlsByToken = yield* resolveGitHubLinksForInlinePathCodeSpans(
            extractInlinePathCodeSpanRefs(rewrittenHistorySource),
            worktreePath,
          );
          const renderedHistorySource = rewriteInlinePathCodeSpansForDiscord({
            text: rewrittenHistorySource,
            githubUrlsByToken: historyInlineGitHubUrlsByToken,
          });
          streamHistoryTextBody = buildStreamHistoryMarkdownText(renderedHistorySource);
        }

        let slots = DISCORD_MAX_FILES_PER_MESSAGE;
        const files: DiscordUploadFile[] = [];
        if (streamHistoryTextBody !== null) {
          files.push(textFile(STREAM_HISTORY_MARKDOWN_NAME, streamHistoryTextBody));
          slots -= 1;
        }

        const imageFiles = yield* loadAttachmentFiles(pendingImages, slots);
        files.push(...imageFiles);
        slots -= imageFiles.length;

        const mdLoaded = yield* loadMarkdownImageFiles(
          pendingMarkdown,
          state.postedMarkdownImageSrcs,
          slots,
        );
        files.push(...mdLoaded.files);
        slots -= mdLoaded.files.length;

        const linkedFilesLoaded = yield* loadMarkdownLinkedFiles(
          pendingMarkdownFiles,
          state.postedMarkdownFileSrcs,
          slots,
        );
        files.push(...linkedFilesLoaded.files);

        yield* Effect.logInfo("Discord finalize attachments ready", {
          fileCount: files.length,
          names: files.map((f) => f.name),
          totalBytes: files.reduce((sum, f) => sum + f.data.byteLength, 0),
        });

        const postedFromFiles = pendingImages.slice(0, imageFiles.length).map((entry) => entry.id);

        // Split once for local-file rewrite notes; re-split after optional table .txt attachments.
        const initialSplit = splitFilesForDiscordUpload(files);
        const oversizedByName = new Set(initialSplit.oversized.map((file) => file.name));
        const attachedFileNames = new Set(
          initialSplit.batches.flatMap((batch) => batch.map((file) => file.name)),
        );

        // Final channel text: strip image embeds but keep readable local file references.
        // Never leave Working.. or the stream placeholder.
        const finalText = rewriteMarkdownLocalFileLinksForDiscord({
          text: stripWorkingIndicator(stripMarkdownImages(text)),
          githubUrlsBySrc,
          attachedFileNames,
          oversizedByName,
        })
          .replace(/_\(attachment will attach when done\)_/giu, "")
          .replace(/_\(\d+ attachments will attach when done\)_/giu, "")
          .replace(/\n{3,}/g, "\n\n")
          .trim();
        const finalInlineGitHubUrlsByToken = yield* resolveGitHubLinksForInlinePathCodeSpans(
          extractInlinePathCodeSpanRefs(finalText),
          worktreePath,
        );
        const pathRewrittenFinalText = rewriteInlinePathCodeSpansForDiscord({
          text: finalText,
          githubUrlsByToken: finalInlineGitHubUrlsByToken,
        });
        // Discord does not render GFM pipe tables — convert to fenced ASCII grids.
        const tableRewrite = rewriteMarkdownTablesForDiscord(pathRewrittenFinalText, {
          style: "rounded",
          messageLimit: DISCORD_LIMIT,
        });
        for (const attachment of tableRewrite.attachments) {
          files.push(textFile(attachment.name, attachment.body, "text/plain;charset=utf-8"));
        }
        const renderedFinalText = tableRewrite.text;

        const { batches: uploadBatches, oversized: oversizedFiles } =
          tableRewrite.attachments.length > 0 ? splitFilesForDiscordUpload(files) : initialSplit;

        // Avoid posting a lone "…" placeholder (what you saw in Discord when an image-only
        // turn failed to attach and had no remaining text). Prefer empty content + files,
        // or a short failure note if we expected images but loaded none.
        const baseFinalChunks: string[] =
          renderedFinalText !== ""
            ? chunkDiscordContentPreservingTables(renderedFinalText, DISCORD_LIMIT)
            : files.length > 0
              ? [""]
              : pendingMarkdown.length > 0 ||
                  pendingImages.length > 0 ||
                  pendingMarkdownFiles.length > 0
                ? ["_(Could not attach file.)_"]
                : text.trim() !== ""
                  ? ["_(done)_"]
                  : [];

        // Small italic turn stats on the final answer (model / effort / duration / tokens).
        const statsThread = yield* Ref.get(latestThreadRef);
        const statsLine = formatTurnResponseStatsLine({
          modelSelection: statsThread?.modelSelection ?? null,
          ...(statsThread?.activities !== undefined ? { activities: statsThread.activities } : {}),
          turnId,
          latestTurn: statsThread?.latestTurn ?? null,
        });
        const finalChunks = appendStatsToMessageChunks(baseFinalChunks, statsLine, DISCORD_LIMIT);

        if (finalChunks.length === 0 && files.length === 0) {
          // Nothing useful to post — just clear any leftover Working.. stream messages.
          yield* deleteMessages(allStreamIds(state));
          yield* Ref.update(stateRef, (current) => ({
            ...current,
            discordMessageIds: [],
            staleStreamMessageIds: [],
            streamBreakPrefix: "",
            currentTurnId: turnId,
            lastAssistantText: text,
            finalizedTurnId: turnId,
            finalDiscordMessageIds: [],
            streamHistoryPosted: current.streamHistoryPosted || streamHistoryTextBody !== null,
            postedAttachmentIds: [...new Set([...current.postedAttachmentIds, ...postedFromFiles])],
            postedMarkdownImageSrcs: [
              ...new Set([...current.postedMarkdownImageSrcs, ...mdLoaded.loadedSrcs]),
            ],
            postedMarkdownFileSrcs: [
              ...new Set([...current.postedMarkdownFileSrcs, ...linkedFilesLoaded.loadedSrcs]),
            ],
            seededWorkingAckPending: false,
          }));
          yield* persistStreamMessageIds([]);
          yield* persistFinalizedAssistant(t3MessageId);
          return;
        }

        const streamIds = [...state.discordMessageIds];
        const staleIds = [...state.staleStreamMessageIds];
        const toDelete = [...streamIds, ...staleIds];
        yield* Effect.logInfo("Finalizing Discord assistant delivery", {
          t3ThreadId: input.t3ThreadId,
          turnId,
          t3MessageId,
          hadPriorFinalize: alreadyFinalized,
          finalTextLength: finalText.length,
          finalChunkCount: finalChunks.length,
          pendingChatImageCount: pendingImages.length,
          pendingMarkdownImageCount: pendingMarkdown.length,
          pendingMarkdownFileCount: pendingMarkdownFiles.length,
          streamHistoryWillPost: streamHistoryTextBody !== null,
          streamIds,
          staleIds,
        });

        /**
         * Always create final message(s) then delete every in-progress tip.
         * Never edit stream tips in place: multi-bubble turns leave long interim
         * narration in those tips, and "edit to final" either keeps that text or
         * fails to drop extra Working.. chunks. Discord cannot add attachments via edit.
         *
         * Accept-without-ack: if a prior attempt already landed text chunks (timeout
         * before we recorded ids), adopt those message ids instead of createMessage again.
         */
        const createFinalWithAttachments = Effect.gen(function* () {
          const ids: string[] = [];
          for (let index = 0; index < finalChunks.length; index += 1) {
            const chunk = finalChunks[index] ?? "";
            const content = chunk.trim() !== "" ? chunk : "_(done)_";
            const created = yield* createMessageWithFiles(content, []);
            ids.push(created.id);
            // Persist durable finalize marker as soon as the first text chunk lands so a
            // later timeout cannot treat this assistant as undelivered and re-post.
            if (index === 0) {
              yield* persistFinalizedAssistant(t3MessageId);
              yield* Ref.update(stateRef, (current) => ({
                ...current,
                finalizedTurnId: turnId,
                t3AssistantMessageId: t3MessageId,
                delivery: {
                  ...current.delivery,
                  lastFinalizedAssistantId: t3MessageId,
                  lastFinalizedText: text,
                  phase: "finalized" as const,
                },
              }));
            }
          }

          for (const batch of uploadBatches) {
            yield* Effect.logInfo("Creating Discord attachment batch", {
              files: batch.map((f) => ({
                name: f.name,
                mimeType: f.mimeType,
                bytes: f.data.byteLength,
              })),
              totalBytes: batch.reduce((sum, f) => sum + f.data.byteLength, 0),
            });
            const created = yield* createMessageWithFiles("", batch);
            ids.push(created.id);
          }

          if (oversizedFiles.length > 0) {
            const note = [
              "**Some files could not be attached due to Discord upload limits:**",
              ...oversizedFiles.map(
                (file) => `- \`${file.name}\` (${Math.ceil(file.data.byteLength / 1_000_000)} MB)`,
              ),
            ].join("\n");
            const created = yield* rest.createMessage(input.discordChannelId, { content: note });
            ids.push(created.id);
          }
          return ids;
        });

        let createdIds: ReadonlyArray<string> = [];

        // Scan recent channel messages for an already-landed final (retry after timeout).
        const recent = yield* rest.listMessages(input.discordChannelId, { limit: 25 }).pipe(
          Effect.catchCause(() =>
            Effect.succeed(
              [] as ReadonlyArray<{
                readonly id: string;
                readonly content?: string;
                readonly author?: { readonly id: string };
              }>,
            ),
          ),
        );
        const adoptedFinalIds = findAlreadyPostedFinalChunkIds({
          recentMessages: recent.map((message) => ({
            id: message.id,
            authorId: message.author?.id ?? "",
            content: message.content ?? "",
          })),
          botUserId,
          finalChunks,
          excludeMessageIds: toDelete,
        });
        if (adoptedFinalIds !== null) {
          yield* Effect.logInfo(
            "Finalize adopting already-posted Discord final chunks (idempotent retry)",
            {
              t3ThreadId: input.t3ThreadId,
              turnId,
              t3MessageId,
              adoptedIds: adoptedFinalIds,
            },
          );
          createdIds = adoptedFinalIds;
          // Claim durable finalize before tip cleanup so concurrent recover cannot re-create.
          yield* persistFinalizedAssistant(t3MessageId);
        } else {
          const primary = yield* createFinalWithAttachments.pipe(
            Effect.timeout(BRIDGE_FINALIZE_DISCORD_TIMEOUT),
            Effect.result,
          );
          if (Result.isSuccess(primary)) {
            createdIds = primary.success;
          } else {
            yield* Effect.logError(primary.failure);
            // Re-scan before fallback create — primary may have partially landed.
            const recentAfterTimeout = yield* rest
              .listMessages(input.discordChannelId, { limit: 25 })
              .pipe(
                Effect.catchCause(() =>
                  Effect.succeed(
                    [] as ReadonlyArray<{
                      readonly id: string;
                      readonly content?: string;
                      readonly author?: { readonly id: string };
                    }>,
                  ),
                ),
              );
            const adoptedAfterTimeout = findAlreadyPostedFinalChunkIds({
              recentMessages: recentAfterTimeout.map((message) => ({
                id: message.id,
                authorId: message.author?.id ?? "",
                content: message.content ?? "",
              })),
              botUserId,
              finalChunks,
              excludeMessageIds: toDelete,
            });
            if (adoptedAfterTimeout !== null) {
              yield* Effect.logInfo(
                "Finalize adopting partial Discord final after timeout (skip fallback create)",
                {
                  t3ThreadId: input.t3ThreadId,
                  adoptedIds: adoptedAfterTimeout,
                },
              );
              createdIds = adoptedAfterTimeout;
              yield* persistFinalizedAssistant(t3MessageId);
            } else {
              // Last resort: text createMessages, then a separate multipart create for files only.
              // Also bounded so a hung Discord REST call cannot pin the bridge forever.
              const fallback = Effect.gen(function* () {
                const ids: string[] = [];
                for (const chunk of finalChunks.length > 0 ? finalChunks : ([] as string[])) {
                  const created = yield* rest.createMessage(input.discordChannelId, {
                    content: stripWorkingIndicator(chunk.trim() !== "" ? chunk : "_(done)_"),
                  });
                  ids.push(created.id);
                  if (ids.length === 1) {
                    yield* persistFinalizedAssistant(t3MessageId);
                  }
                }
                if (files.length > 0) {
                  const fileResult = yield* createMessageWithFiles("", files).pipe(Effect.result);
                  if (Result.isSuccess(fileResult)) {
                    ids.push(fileResult.success.id);
                  } else {
                    yield* Effect.logError(fileResult.failure);
                  }
                }
                return ids;
              }).pipe(Effect.timeout(BRIDGE_FINALIZE_DISCORD_TIMEOUT), Effect.result);
              const fallbackResult = yield* fallback;
              if (Result.isSuccess(fallbackResult)) {
                createdIds = fallbackResult.success;
              } else {
                yield* Effect.logError(fallbackResult.failure);
                createdIds = [];
              }
            }
          }
        }

        // Always wipe in-progress tips (including Working.. ack), even if create failed
        // partially — better empty channel than a stuck interim stream.
        yield* deleteMessages(toDelete);

        yield* Ref.update(stateRef, (current) => ({
          ...current,
          discordMessageIds: [],
          staleStreamMessageIds: [],
          streamBreakPrefix: "",
          currentTurnId: turnId,
          lastAssistantText: text,
          finalizedTurnId: turnId,
          t3AssistantMessageId: t3MessageId,
          finalDiscordMessageIds: [...createdIds],
          streamHistoryPosted: current.streamHistoryPosted || streamHistoryTextBody !== null,
          postedAttachmentIds: [...new Set([...current.postedAttachmentIds, ...postedFromFiles])],
          postedMarkdownImageSrcs: [
            ...new Set([...current.postedMarkdownImageSrcs, ...mdLoaded.loadedSrcs]),
          ],
          postedMarkdownFileSrcs: [
            ...new Set([...current.postedMarkdownFileSrcs, ...linkedFilesLoaded.loadedSrcs]),
          ],
          seededWorkingAckPending: false,
          delivery: {
            ...current.delivery,
            phase: "finalized" as const,
            lastFinalizedAssistantId: t3MessageId,
            lastFinalizedText: text,
            finalizedAssistantId: t3MessageId,
            streamText: "",
            settleReady: false,
          },
        }));
        yield* persistStreamMessageIds([]);
        // Durable marker may already be set after first chunk; write again is a no-op merge.
        yield* persistFinalizedAssistant(t3MessageId);

        // Collect any GitHub PR URLs from the finalized answer into the pinned thread-info.
        const prUrlsFromAnswer = extractPullRequestUrls(text);
        if (prUrlsFromAnswer.length > 0) {
          const botConfig = yield* DiscordBotConfig;
          yield* upsertThreadInfoPin({
            discordThreadId: input.discordChannelId,
            t3ThreadId: input.t3ThreadId,
            botConfig,
            incomingPrUrls: prUrlsFromAnswer,
            worktreePath,
            local: worktreePath === null,
          }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Failed to refresh thread info pin with PR links", {
                discordChannelId: input.discordChannelId,
                t3ThreadId: input.t3ThreadId,
                error: String(error),
              }),
            ),
          );
        }

        yield* Effect.logInfo("Discord assistant delivery finalized", {
          t3ThreadId: input.t3ThreadId,
          turnId,
          t3MessageId,
          createdIds,
          deletedInProgressIds: toDelete,
          postedFromFiles,
          uploadedMarkdownImageSrcs: mdLoaded.loadedSrcs,
          uploadedMarkdownFileSrcs: linkedFilesLoaded.loadedSrcs,
        });
      }).pipe(Effect.asVoid);

    const postApprovals = (approvals: ReadonlyArray<PendingApproval>) =>
      Effect.gen(function* () {
        if (approvals.length === 0) return;
        const key = approvals.map((entry) => entry.requestId).join(",");
        const state = yield* Ref.get(stateRef);
        if (state.lastApprovalKey === key) return;

        for (const approval of approvals) {
          yield* rest.createMessage(input.discordChannelId, {
            content: [
              `**Approval required** (${approval.requestKind})`,
              approval.detail ?? "_No detail provided_",
            ].join("\n"),
            components: UI.grid([
              [
                UI.button({
                  custom_id: `t3_approve:${input.t3ThreadId}:${approval.requestId}`,
                  label: "Allow",
                  style: Discord.ButtonStyleTypes.SUCCESS,
                }),
                UI.button({
                  custom_id: `t3_deny:${input.t3ThreadId}:${approval.requestId}`,
                  label: "Deny",
                  style: Discord.ButtonStyleTypes.DANGER,
                }),
              ],
            ]),
          });
        }

        yield* Ref.update(stateRef, (current) => ({
          ...current,
          lastApprovalKey: key,
        }));
      }).pipe(Effect.asVoid);

    /**
     * Apply a Discord thread title only after a successful rename.
     * Never mark `attemptedThreadTitle` before the REST call — a rate-limit /
     * network failure used to poison retries so busy/wake badges never appeared.
     */
    const applyDiscordThreadTitle = (desiredTitle: string, reason: string) =>
      Effect.gen(function* () {
        const latest = yield* Ref.get(stateRef);
        if (latest.mirroredThreadTitle === desiredTitle) {
          return;
        }
        yield* rest.updateChannel(input.discordChannelId, { name: desiredTitle });
        yield* Effect.logInfo("Discord thread title mirrored to Discord", {
          discordChannelId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
          desiredTitle,
          reason,
        });
        yield* Ref.update(stateRef, (current) => ({
          ...current,
          attemptedThreadTitle: desiredTitle,
          mirroredThreadTitle: desiredTitle,
        }));
      });

    /**
     * Idempotent title badge sync.
     *
     * Dual optional columns (like T3 client): `| PR | activity | Title`.
     * Activity (busy / wake-required) is independent of sticky PR evidence.
     * Unknown remote never paints ▫️.
     */
    const syncDiscordThreadTitle = (thread: OrchestrationThread) =>
      titleSyncLock
        .withPermit(
          Effect.gen(function* () {
            const state = yield* Ref.get(stateRef);
            const titleBase = (value: string) =>
              decorateDiscordThreadTitle(value, null, 100, false);
            const currentBase = titleBase(thread.title);
            const alreadySettled =
              (state.mirroredThreadTitle !== null &&
                titleBase(state.mirroredThreadTitle) === currentBase) ||
              (state.attemptedThreadTitle !== null &&
                titleBase(state.attemptedThreadTitle) === currentBase);

            const cachedStatus = yield* Ref.get(latestVcsStatusRef);
            const remoteObserved = yield* Ref.get(vcsRemoteObservedRef);
            const stickyBefore = yield* Ref.get(stickyTitlePrRef);
            const statusPr = toStickyTitlePrEvidence(
              resolveThreadTitleChangeRequestFromStatus(thread, cachedStatus),
            );

            const activity = resolveDiscordThreadActivityBadgeState({
              sessionStatus: thread.session?.status ?? null,
              activeTurnId: thread.session?.activeTurnId ?? null,
              latestTurnState: thread.latestTurn?.state ?? null,
              latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
            });

            // Fast path: settled base + no new PR evidence from warm VCS — compose
            // PR (sticky) + activity without GH dual-lookup.
            if (alreadySettled && statusPr === null) {
              const evidence = resolveDiscordTitlePrEvidence({
                stickyPr: stickyBefore,
                statusPr: null,
                remoteStatusObserved: remoteObserved,
              });
              yield* Ref.set(stickyTitlePrRef, evidence.stickyPr);
              const upgradeTitle = resolveSettledDiscordThreadTitleUpgrade({
                thread,
                mirroredThreadTitle: state.mirroredThreadTitle,
                attemptedThreadTitle: state.attemptedThreadTitle,
                cachedPr: evidence.effectivePr,
                canApplyNoPrBadge: evidence.canApplyNoPrBadge,
              });
              if (upgradeTitle === null) return;
              yield* applyDiscordThreadTitle(
                upgradeTitle,
                activity !== null ? "dual-badge-settled" : "settled-title-badge-upgrade",
              );
              return;
            }

            const project = yield* t3.getProjectShell(thread.projectId);
            const branch = thread.branch;

            // Prefer warm VCS stream. Only cold-start GH lookup when remote is unknown
            // and sticky is empty — never dual-source every snapshot.
            let branchLookupPr: StickyTitlePrEvidence | null = null;
            let branchLookupCompleted = false;
            let prSource: "vcs-status-stream" | "sticky" | "branch-lookup" | "none" = "none";
            let lookupCwds: ReadonlyArray<string> = [];

            if (statusPr !== null) {
              prSource = "vcs-status-stream";
            } else if (stickyBefore !== null) {
              prSource = "sticky";
            } else if (!remoteObserved && branch !== null && project !== null) {
              lookupCwds = resolveThreadChangeRequestLookupCwds(thread, project);
              for (const cwd of lookupCwds) {
                const resolved = yield* t3
                  .resolveBranchChangeRequest({
                    cwd,
                    refName: branch,
                  })
                  .pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("Discord thread title PR lookup failed", {
                        discordChannelId: input.discordChannelId,
                        t3ThreadId: input.t3ThreadId,
                        title: thread.title,
                        branch,
                        cwd,
                        cause: formatAlertCause(cause, 400),
                      }).pipe(Effect.as({ pr: null })),
                    ),
                  );
                yield* Effect.logInfo("Discord thread title PR lookup result", {
                  discordChannelId: input.discordChannelId,
                  t3ThreadId: input.t3ThreadId,
                  title: thread.title,
                  branch,
                  cwd,
                  prNumber: resolved.pr?.number ?? null,
                  prState: resolved.pr?.state ?? null,
                  prHeadRef: resolved.pr?.headRef ?? null,
                  prBaseRef: resolved.pr?.baseRef ?? null,
                });
                if (resolved.pr !== null) {
                  branchLookupPr = toStickyTitlePrEvidence(resolved.pr);
                  prSource = "branch-lookup";
                  break;
                }
              }
              // Completed the cold-start lookup path (possibly with no PR).
              branchLookupCompleted = true;
              if (prSource === "none") prSource = "branch-lookup";
            } else if (branch === null || project === null) {
              yield* Effect.logInfo("Discord thread title sync skipping PR lookup", {
                discordChannelId: input.discordChannelId,
                t3ThreadId: input.t3ThreadId,
                title: thread.title,
                branch,
                hasProject: project !== null,
                worktreePath: thread.worktreePath,
              });
            }

            const evidence = resolveDiscordTitlePrEvidence({
              stickyPr: stickyBefore,
              statusPr,
              remoteStatusObserved: remoteObserved,
              branchLookupPr,
              branchLookupCompleted,
            });
            yield* Ref.set(stickyTitlePrRef, evidence.stickyPr);

            const prState = threadTitleChangeRequestState(thread, evidence.effectivePr);
            // Unknown evidence: do not paint ▫️ / no-PR from missing data.
            const effectivePrState: DiscordThreadPrBadgeState =
              prState === "initialized" && !evidence.canApplyNoPrBadge ? null : prState;

            const latest = yield* Ref.get(stateRef);
            const mirroredBadges = parseDiscordThreadTitleBadges(latest.mirroredThreadTitle);
            const currentBadges =
              mirroredBadges.pr !== null || mirroredBadges.activity !== null
                ? mirroredBadges
                : parseDiscordThreadTitleBadges(latest.attemptedThreadTitle);
            const prAllowed = shouldApplyDiscordThreadPrBadge(currentBadges.pr, effectivePrState);
            const appliedPr = prAllowed ? effectivePrState : currentBadges.pr;

            // Still nothing actionable (no PR column, no activity, nothing mirrored).
            if (appliedPr === null && activity === null && currentBadges.pr === null) {
              yield* Effect.logInfo("Discord thread title sync deferred; PR evidence not ready", {
                discordChannelId: input.discordChannelId,
                t3ThreadId: input.t3ThreadId,
                remoteObserved,
                stickyPr: evidence.stickyPr?.number ?? null,
                prSource,
                activity,
              });
              return;
            }

            const desiredTitle = decorateDiscordThreadTitle(
              thread.title,
              {
                pr: appliedPr,
                activity,
                hasFailingChecks:
                  appliedPr === "open" && evidence.effectivePr?.hasFailingChecks === true,
              },
              100,
            );
            yield* Effect.logInfo("Discord thread title sync resolved", {
              discordChannelId: input.discordChannelId,
              t3ThreadId: input.t3ThreadId,
              title: thread.title,
              branch,
              worktreePath: thread.worktreePath,
              projectWorkspaceRoot: project?.workspaceRoot ?? null,
              lookupCwds,
              cachedStatusRefName: cachedStatus?.refName ?? null,
              prNumber: evidence.effectivePr?.number ?? null,
              prState: effectivePrState,
              appliedPr,
              activity,
              sessionStatus: thread.session?.status ?? null,
              prSource,
              remoteObserved,
              canApplyNoPrBadge: evidence.canApplyNoPrBadge,
              desiredTitle,
              currentBadges,
              prAllowed,
              mirroredThreadTitle: latest.mirroredThreadTitle,
              attemptedThreadTitle: latest.attemptedThreadTitle,
            });
            // Only skip when Discord already shows the desired dual-slot title.
            if (latest.mirroredThreadTitle === desiredTitle) {
              return;
            }
            const mirroredBase =
              latest.mirroredThreadTitle === null ? null : titleBase(latest.mirroredThreadTitle);
            const sameTitleBase = mirroredBase === currentBase;
            // Refuse pure PR demotion when base unchanged — but still allow activity-only
            // changes (e.g. keep 🔀 and add/remove ⏳).
            if (!prAllowed && sameTitleBase && appliedPr === currentBadges.pr) {
              // appliedPr kept sticky current; activity may still differ — continue apply.
            }

            yield* applyDiscordThreadTitle(desiredTitle, "title-sync");
          }),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to mirror T3 thread title to Discord thread", {
              discordChannelId: input.discordChannelId,
              t3ThreadId: input.t3ThreadId,
              title: thread.title,
              cause: formatAlertCause(cause, 400),
            }),
          ),
          Effect.asVoid,
        );

    controlSlot.refreshThreadIndicators = () =>
      Effect.gen(function* () {
        let thread = yield* Ref.get(latestThreadRef);
        if (thread === null) {
          for (let attempt = 0; attempt < 20; attempt += 1) {
            yield* Effect.sleep("100 millis");
            thread = yield* Ref.get(latestThreadRef);
            if (thread !== null) break;
          }
        }
        if (thread === null) {
          return {
            ok: false as const,
            error: "T3 thread not available yet for indicator refresh; try again in a moment",
          };
        }

        // Force full re-evaluation: drop settle cache, sticky PR, and VCS cache.
        yield* Ref.update(stateRef, (current) => ({
          ...current,
          mirroredThreadTitle: null,
          attemptedThreadTitle: null,
        }));
        yield* Ref.set(latestVcsStatusRef, null);
        yield* Ref.set(stickyTitlePrRef, null);
        yield* Ref.set(vcsRemoteObservedRef, false);

        if (thread.worktreePath !== null) {
          yield* t3.refreshVcsStatus(thread.worktreePath).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Forced VCS status refresh failed during indicator refresh", {
                discordChannelId: input.discordChannelId,
                t3ThreadId: input.t3ThreadId,
                cause: formatAlertCause(cause, 300),
              }),
            ),
          );
        }

        yield* syncDiscordThreadTitle(thread);
        const state = yield* Ref.get(stateRef);
        if (state.mirroredThreadTitle !== null) {
          yield* Effect.logInfo("Discord thread indicators refreshed", {
            discordChannelId: input.discordChannelId,
            t3ThreadId: input.t3ThreadId,
            title: state.mirroredThreadTitle,
          });
          return { ok: true as const, title: state.mirroredThreadTitle };
        }

        // Last resort: mirror plain decorated title without PR (still clears stale badges).
        const fallbackTitle = decorateDiscordThreadTitle(
          thread.title,
          threadTitleChangeRequestState(thread, null),
          100,
          false,
        );
        yield* rest.updateChannel(input.discordChannelId, { name: fallbackTitle });
        yield* Ref.update(stateRef, (current) => ({
          ...current,
          mirroredThreadTitle: fallbackTitle,
          attemptedThreadTitle: fallbackTitle,
        }));
        yield* Effect.logInfo("Discord thread indicators refreshed (fallback title)", {
          discordChannelId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
          title: fallbackTitle,
        });
        return { ok: true as const, title: fallbackTitle };
      }).pipe(
        Effect.catch((error: unknown) =>
          Effect.succeed({
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
      );

    const stopVcsStatusSubscription = Effect.gen(function* () {
      const subscription = yield* Ref.get(vcsStatusSubscriptionRef);
      if (subscription === null) return;
      yield* Fiber.interrupt(subscription.fiber).pipe(Effect.ignore);
      yield* Ref.set(vcsStatusSubscriptionRef, null);
      yield* Ref.set(latestVcsStatusRef, null);
      // Keep sticky PR + remoteObserved across cwd resubscribe so a worktree path
      // bounce does not re-open the null→▫️ window. Force-refresh clears them.
      yield* Effect.logInfo("Discord thread title VCS status subscription stopped", {
        discordChannelId: input.discordChannelId,
        t3ThreadId: input.t3ThreadId,
        cwd: subscription.cwd,
      });
    });

    const ensureVcsStatusSubscription = (thread: OrchestrationThread) =>
      Effect.gen(function* () {
        yield* Ref.set(latestThreadRef, thread);

        const cwd = thread.worktreePath;
        const subscription = yield* Ref.get(vcsStatusSubscriptionRef);
        if (cwd === null) {
          yield* stopVcsStatusSubscription;
          return;
        }
        if (subscription?.cwd === cwd) {
          return;
        }

        yield* stopVcsStatusSubscription;
        // Server-side VcsStatusBroadcaster already runs one remote poller per cwd when
        // clients subscribe. Do NOT also force-refresh every 30s from the bot — that
        // doubled GitHub/gh fan-out across every Discord bridge and starved the server.
        // forkDetach (not forkScoped): bridge fibers are started with forkDetach and
        // have no ambient Scope. forkScoped here used to fail every onThread after
        // rehydrate, so Discord stream/finalize never ran while T3 kept working.
        const fiber = yield* t3
          .subscribeVcsStatus(cwd, (event) =>
            Effect.gen(function* () {
              // Only real remote payloads count as observed. localUpdated / snapshot
              // with remote:null must not unlock the no-PR (▫️) badge.
              if (
                event._tag === "remoteUpdated" ||
                (event._tag === "snapshot" && event.remote !== null)
              ) {
                yield* Ref.set(vcsRemoteObservedRef, true);
              }
              yield* Ref.update(latestVcsStatusRef, (current) =>
                applyGitStatusStreamEvent(current, event),
              );
              const currentThread = yield* Ref.get(latestThreadRef);
              if (currentThread === null) return;

              yield* Effect.logInfo("Discord thread title VCS status update received", {
                discordChannelId: input.discordChannelId,
                t3ThreadId: input.t3ThreadId,
                cwd,
                eventTag: event._tag,
                remoteObserved:
                  event._tag === "remoteUpdated" ||
                  (event._tag === "snapshot" && event.remote !== null),
              });
              yield* syncDiscordThreadTitle(currentThread);
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Discord thread title VCS status subscription failed", {
                discordChannelId: input.discordChannelId,
                t3ThreadId: input.t3ThreadId,
                cwd,
                cause: formatAlertCause(cause, 400),
              }),
            ),
            Effect.asVoid,
            Effect.forkDetach,
          );
        yield* Ref.set(vcsStatusSubscriptionRef, { cwd, fiber });
        yield* Effect.logInfo("Discord thread title VCS status subscription started", {
          discordChannelId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
          cwd,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("ensureVcsStatusSubscription failed", {
              discordChannelId: input.discordChannelId,
              t3ThreadId: input.t3ThreadId,
              cause: formatAlertCause(cause, 400),
            });
            yield* postBridgeAlert(
              `vcs-sub:${input.discordChannelId}`,
              "VCS title subscription failed",
              [
                `channel=\`${input.discordChannelId}\``,
                `thread=\`${input.t3ThreadId}\``,
                formatAlertCause(cause),
              ].join("\n"),
            );
          }).pipe(Effect.asVoid),
        ),
      );

    let subscriptionReady = false;
    const signalReady = Effect.gen(function* () {
      if (subscriptionReady) return;
      subscriptionReady = true;
      yield* Deferred.succeed(ready, undefined);
      yield* Effect.logInfo("First T3 thread snapshot received; subscription live", {
        t3ThreadId: input.t3ThreadId,
      });
    });

    const updateWorkingHeartbeat = Effect.fn("ResponseBridge.updateWorkingHeartbeat")(function* (
      workingDots: WorkingDotCount,
    ) {
      yield* streamWriteLock.withPermit(
        Effect.gen(function* () {
          const state = yield* Ref.get(stateRef);
          let tipId = state.discordMessageIds.at(-1) ?? null;
          const latest = yield* Ref.get(latestThreadRef);
          const turnRunning = latest !== null && isTurnInProgress(latest);
          const toolCallCount = currentTurnToolCallCount(latest);

          const hb = decideHeartbeat({
            state: state.delivery,
            turnInProgress: turnRunning,
            hasOpenTip: tipId !== null,
          });
          if (hb._tag === "noop") return;

          // No tip yet but epoch still awaiting/streaming: recreate Working dots only.
          if (tipId === null) {
            if (
              !shouldRecreateTip({
                state: state.delivery,
                updateFailed: true,
                turnInProgress: turnRunning,
              })
            ) {
              return;
            }
            const content = formatInProgressChunk(
              "",
              true,
              DISCORD_LIMIT,
              workingDots,
              toolCallCount,
            );
            const created = yield* rest.createMessage(input.discordChannelId, {
              ...workingMessageFields(content, input.t3ThreadId),
            });
            yield* Ref.update(stateRef, (current) => ({
              ...current,
              discordMessageIds: [created.id],
              seededWorkingAckPending: current.delivery.phase === "awaiting",
            }));
            yield* persistStreamMessageIds([created.id]);
            yield* Effect.logInfo("Heartbeat recreated missing Working tip for running turn", {
              t3ThreadId: input.t3ThreadId,
              messageId: created.id,
              epoch: state.delivery.epoch,
              phase: state.delivery.phase,
              toolCallCount,
            });
            return;
          }

          // If a human replied under us, freeze on the next stream write; heartbeat must
          // not recreate a full-content tip under the user message. Bot Tasks posts are
          // owned and must not silence the Working tip.
          if (yield* isStreamTipDisplaced(tipId)) return;

          // Epoch FSM: awaiting → dots only; streaming → current epoch streamText only.
          const tipDisplay = hb.tipBody;
          if (state.streamBreakPrefix !== "" && tipDisplay.trim() === "") return;

          const chunks =
            tipDisplay.trim() === ""
              ? ([""] as string[])
              : chunkDiscordContent(tipDisplay, STREAM_CHUNK_LIMIT);
          const tipChunk = chunks.at(-1) ?? "";
          const content = formatInProgressChunk(
            tipChunk,
            true,
            DISCORD_LIMIT,
            workingDots,
            toolCallCount,
          );
          const fields = workingMessageFields(content, input.t3ThreadId);
          const updated = yield* rest
            .updateMessage(input.discordChannelId, tipId, { ...fields })
            .pipe(Effect.result);
          if (
            shouldRecreateTip({
              state: state.delivery,
              updateFailed: Result.isFailure(updated),
              turnInProgress: turnRunning,
            })
          ) {
            const created = yield* rest.createMessage(input.discordChannelId, { ...fields });
            tipId = created.id;
            yield* Ref.update(stateRef, (current) => ({
              ...current,
              discordMessageIds: [created.id],
              staleStreamMessageIds: uniqueDiscordMessageIds([
                ...current.staleStreamMessageIds,
                ...current.discordMessageIds,
              ]),
            }));
            const after = yield* Ref.get(stateRef);
            yield* persistStreamMessageIds(allStreamIds(after));
            yield* Effect.logWarning("Heartbeat recreated dead Working tip", {
              t3ThreadId: input.t3ThreadId,
              messageId: created.id,
              cause: formatAlertCause(Result.isFailure(updated) ? updated.failure : "unknown", 200),
            });
          }
        }),
      );
    });

    const alertStreamFailure = (phase: string) => (cause: unknown) =>
      Effect.gen(function* () {
        const pretty = formatAlertCause(cause);
        yield* Effect.logError("Discord stream post/edit failed", {
          discordChannelId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
          phase,
          cause: pretty,
        });
        yield* postBridgeAlert(
          `stream:${input.discordChannelId}:${phase}`,
          "Discord stream post/edit failed",
          [
            `channel=\`${input.discordChannelId}\``,
            `thread=\`${input.t3ThreadId}\``,
            `phase=\`${phase}\``,
            pretty,
          ].join("\n"),
        );
      }).pipe(Effect.asVoid);

    /**
     * Keep the pinned thread-info Model line in sync when the T3 thread model changes
     * (Discord `--model` flag, web UI, etc.). Includes "since …, started with …" history.
     */
    const syncThreadInfoModelPin = (thread: OrchestrationThread) =>
      Effect.gen(function* () {
        const modelSelection = thread.modelSelection;
        if (modelSelection === undefined || modelSelection === null) return;

        const modelLine = formatModelSelectionLine(modelSelection);
        const link = yield* links.getByDiscordThreadId(input.discordChannelId);
        if (link === null) return;
        if (link.currentModelLine === modelLine) return;

        const botConfig = yield* DiscordBotConfig;
        yield* upsertThreadInfoPin({
          discordThreadId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
          botConfig,
          modelSelection,
          worktreePath: thread.worktreePath,
          local: thread.worktreePath === null,
        });
        yield* Effect.logInfo("Thread info pin model updated", {
          discordChannelId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
          previousModel: link.currentModelLine ?? null,
          nextModel: modelLine,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Failed to sync thread info model pin", {
            discordChannelId: input.discordChannelId,
            t3ThreadId: input.t3ThreadId,
            error: String(error),
          }),
        ),
      );

    /**
     * Apply one thread snapshot to Discord (stream tip / finalize / tasks / title).
     * Must not run concurrently for the same bridge — callers serialize via deliveryLock.
     *
     * Order matters: assistant stream/finalize runs **before** title/pin/side work.
     * Mid-turn thread renames used to run first (with optional GH PR lookups) and hold
     * this queue so intermediate tip edits coalesced away — Discord stayed on
     * `_Working.._` until the final, while the channel name still updated. Finals
     * still landed; live progress did not.
     */
    const processThreadSnapshot = (thread: OrchestrationThread) =>
      Effect.gen(function* () {
        yield* ensureVcsStatusSubscription(thread);

        // Cheap bookkeeping only — no Discord REST — so we do not delay the tip path.
        const threadUserMessageIds = uniqueMessageIds(
          thread.messages.filter((message) => message.role === "user").map((message) => message.id),
        );
        const priorState = yield* Ref.get(stateRef);
        const unseenExternalUserMessages = externalUserMessagesToEcho({
          messages: thread.messages,
          observedInitialUserSnapshot: priorState.observedInitialUserSnapshot,
          seenUserMessageIds: priorState.seenUserMessageIds,
          sentDiscordUserMessageIds: priorState.sentDiscordUserMessageIds,
        });
        const unresolvedSentDiscordUserMessageIds = priorState.sentDiscordUserMessageIds.filter(
          (messageId) => !threadUserMessageIds.includes(messageId),
        );
        yield* Ref.update(stateRef, (current) => ({
          ...current,
          seenUserMessageIds: uniqueMessageIds([
            ...current.seenUserMessageIds,
            ...threadUserMessageIds,
          ]),
          observedInitialUserSnapshot: true,
          sentDiscordUserMessageIds: unresolvedSentDiscordUserMessageIds,
        }));
        if (
          unresolvedSentDiscordUserMessageIds.length !== priorState.sentDiscordUserMessageIds.length
        ) {
          yield* persistSentDiscordUserMessageIds(unresolvedSentDiscordUserMessageIds);
        }

        const activeTurnId = thread.latestTurn?.turnId ?? null;
        const turnInProgressNow = isTurnInProgress(thread);

        // Interrupted session (Wake Required): convert open Working tips to a Continue notice
        // before catch-up finalize would treat partial stream as a finished answer.
        {
          const preWake = yield* Ref.get(stateRef);
          if (
            shouldConvertWorkingTipsToWakeUp({
              sessionStatus: thread.session?.status ?? null,
              activeTurnId: thread.session?.activeTurnId ?? null,
              latestTurnState: thread.latestTurn?.state ?? null,
              latestTurnCompletedAt: thread.latestTurn?.completedAt ?? null,
              turnInProgress: turnInProgressNow,
              openStreamTipCount: allStreamIds(preWake).length,
              wakeUpNoticePosted: preWake.wakeUpNoticePosted,
            })
          ) {
            yield* convertWorkingTipsToWakeUp("session-interrupted").pipe(
              Effect.catchCause(alertStreamFailure("wake-up-convert")),
              Effect.asVoid,
            );
          }
        }

        const assistant = thread.messages.findLast((message) => message.role === "assistant");

        // --- Primary: stream tip / finalize (user-visible progress) ---
        // Skip stream/finalize when we just converted (or previously posted) a wake-up notice
        // for a real mid-turn interrupt — partial content is not a completed final.
        const afterWakeState = yield* Ref.get(stateRef);
        if (isSessionWakeRequired(thread) && afterWakeState.wakeUpNoticePosted) {
          // Secondary path still runs for title (❗) / pin / tasks.
        } else if (assistant !== undefined) {
          const prior = yield* Ref.get(stateRef);

          // Structural delivery: assistants allowed for Discord this snapshot (epoch FSM).
          // lastFinalizedAssistantId excludes prior-turn bodies even while the new turn
          // is already in progress (snapshot race before the new user message lands).
          // Re-read durable cursor each snapshot so reconnect/catch-up cannot ignore a
          // finalize written by a prior epoch or after a delivery-state reset.
          const durableLinkNow = yield* links
            .getByDiscordThreadId(input.discordChannelId)
            .pipe(Effect.catchCause(() => Effect.succeed(null)));
          const lastFinalizedForDelivery =
            prior.delivery.lastFinalizedAssistantId ??
            durableLinkNow?.lastFinalizedAssistantId ??
            persistedLink?.lastFinalizedAssistantId ??
            warmCacheEntry?.lastFinalizedAssistantId ??
            null;
          const lastFinalizedTextForDelivery = prior.delivery.lastFinalizedText ?? null;
          const threadMessagesForDelivery = thread.messages.map((message) => ({
            id: message.id,
            role: message.role,
            turnId: message.turnId,
            text: message.text,
          }));
          const deliveryAssistants = assistantMessagesForDelivery({
            messages: threadMessagesForDelivery,
            turnId: activeTurnId,
            turnInProgress: turnInProgressNow,
            hasLatestTurn: thread.latestTurn !== null && thread.latestTurn !== undefined,
            lastFinalizedAssistantId: lastFinalizedForDelivery,
            lastFinalizedText: lastFinalizedTextForDelivery,
          });
          const deliveryAssistantIds = new Set(deliveryAssistants.map((entry) => entry.id));
          const turnAssistants = thread.messages.filter(
            (message) => message.role === "assistant" && deliveryAssistantIds.has(message.id),
          );
          const images = turnAssistants.flatMap((message) =>
            imageAttachmentsOf(message.attachments),
          );
          const streaming =
            turnInProgressNow ||
            turnAssistants.some(
              (message) => isAssistantStreaming(thread, message.id) || message.streaming === true,
            );

          const decision = decideAssistantDelivery({
            state: {
              ...prior.delivery,
              // Keep durable finalize memory from the link store in sync.
              lastFinalizedAssistantId: lastFinalizedForDelivery,
              lastFinalizedText: lastFinalizedTextForDelivery,
            },
            turnId: activeTurnId,
            turnInProgress: turnInProgressNow,
            assistants: deliveryAssistants.map((entry) => ({
              id: entry.id,
              text: entry.text,
            })),
            messages: threadMessagesForDelivery,
            streaming,
            presentationFull: (input.presentationMode ?? "full") === "full",
            // Idle catch-up (rehydrate *or* interactive recovery after a comment) often
            // gets a single settled snapshot — do not stream the previous final under
            // `_Working.._` + Stop waiting for a second settle tick that never arrives.
            // Substantial answers also finalize immediately inside decideAssistantDelivery.
            skipSettleGrace: !turnInProgressNow,
          });

          yield* Effect.logInfo("Discord delivery decision", {
            t3ThreadId: input.t3ThreadId,
            turnId: activeTurnId,
            intent: decision.intent._tag,
            reason:
              decision.intent._tag === "noop" || decision.intent._tag === "hold"
                ? decision.intent.reason
                : null,
            phase: decision.state.phase,
            epoch: decision.state.epoch,
            settleReady: decision.state.settleReady,
            deliveryAssistants: deliveryAssistants.length,
            streaming,
            turnInProgress: turnInProgressNow,
          });

          // Apply non-terminal state before I/O; finalize commits only after successful post
          // so a failed finalize can retry without being stuck in phase=finalized.
          if (decision.intent._tag !== "finalize") {
            // Late multi-bubble reopen: epoch left finalized → streaming/awaiting with a
            // new assistant after lastFinalized. Clear bridge finalizedTurnId so stream /
            // re-finalize is not treated as a no-op duplicate of the short status final.
            const reopenedAfterPrematureFinal =
              prior.delivery.phase === "finalized" &&
              (decision.state.phase === "streaming" || decision.state.phase === "awaiting");
            yield* Ref.update(stateRef, (current) => ({
              ...current,
              delivery: decision.state,
              adoptedInitialSnapshot: true,
              seededWorkingAckPending: decision.state.phase === "awaiting",
              lastAssistantText:
                decision.state.phase === "streaming"
                  ? decision.state.streamText
                  : decision.state.phase === "awaiting"
                    ? ""
                    : current.lastAssistantText,
              finalizedTurnId:
                decision.state.phase === "awaiting" || reopenedAfterPrematureFinal
                  ? null
                  : current.finalizedTurnId,
              currentTurnId: decision.state.turnId ?? current.currentTurnId,
              t3AssistantMessageId: decision.state.assistantId ?? current.t3AssistantMessageId,
            }));
          } else {
            yield* Ref.update(stateRef, (current) => ({
              ...current,
              adoptedInitialSnapshot: true,
            }));
          }

          if (decision.intent._tag === "stream") {
            yield* postOrEditAssistant({
              turnId: decision.intent.turnId,
              t3MessageId: decision.intent.assistantId,
              text: decision.intent.text,
              streaming: true,
              images,
              worktreePath: thread.worktreePath,
            }).pipe(Effect.catchCause(alertStreamFailure("live-stream")), Effect.asVoid);
          } else if (decision.intent._tag === "finalize") {
            yield* postOrEditAssistant({
              turnId: decision.intent.turnId,
              t3MessageId: decision.intent.assistantId,
              text: decision.intent.text,
              streaming: false,
              images,
              worktreePath: thread.worktreePath,
            }).pipe(Effect.catchCause(alertStreamFailure("finalize")), Effect.asVoid);
            // Commit terminal epoch only after finalize attempt (success path updates tips).
            yield* Ref.update(stateRef, (current) => ({
              ...current,
              delivery: decision.state,
              seededWorkingAckPending: false,
              lastAssistantText: "",
              finalizedTurnId: decision.state.turnId ?? activeTurnId,
              currentTurnId: decision.state.turnId ?? current.currentTurnId,
              t3AssistantMessageId: decision.state.assistantId,
            }));
          } else if (
            decision.intent._tag === "noop" &&
            decision.intent.reason === "settled-without-content" &&
            !prior.seededWorkingAckPending &&
            prior.delivery.phase !== "finalized"
          ) {
            // Prefer posting whatever we already streamed over wiping Working with silence.
            const fallbackText = prior.lastAssistantText.trim();
            if (fallbackText !== "" && prior.t3AssistantMessageId !== null) {
              yield* Effect.logInfo(
                "Finalizing from last streamed body (settled without new content)",
                {
                  t3ThreadId: input.t3ThreadId,
                  turnId: activeTurnId,
                  textLen: fallbackText.length,
                },
              );
              yield* postOrEditAssistant({
                turnId: activeTurnId,
                t3MessageId: prior.t3AssistantMessageId,
                text: fallbackText,
                streaming: false,
                images: [],
                worktreePath: thread.worktreePath,
              }).pipe(
                Effect.catchCause(alertStreamFailure("finalize-stream-fallback")),
                Effect.asVoid,
              );
              yield* Ref.update(stateRef, (current) => ({
                ...current,
                delivery: {
                  ...current.delivery,
                  phase: "finalized" as const,
                  streamText: "",
                  settleReady: false,
                  finalizedAssistantId: prior.t3AssistantMessageId,
                  lastFinalizedAssistantId: prior.t3AssistantMessageId,
                  lastFinalizedText: fallbackText,
                },
                seededWorkingAckPending: false,
                lastAssistantText: "",
                finalizedTurnId: activeTurnId,
              }));
            } else {
              yield* clearInProgressMessages("settled-without-final-content").pipe(
                Effect.catchCause(Effect.logError),
                Effect.asVoid,
              );
            }
          }
        } else {
          const stateBefore = yield* Ref.get(stateRef);
          const turnRunningNoAssistant = isTurnInProgress(thread);
          yield* Ref.update(stateRef, (current) =>
            current.adoptedInitialSnapshot ? current : { ...current, adoptedInitialSnapshot: true },
          );
          const state = yield* Ref.get(stateRef);
          yield* Effect.logInfo("Bridge thread update (no assistant message yet)", {
            t3ThreadId: input.t3ThreadId,
            messageCount: thread.messages.length,
            sessionStatus: thread.session?.status ?? null,
            turnState: thread.latestTurn?.state ?? null,
            seededWorkingAckPending: state.seededWorkingAckPending,
            state: summarizeBridgeStateForLog(state),
          });
          if (
            turnRunningNoAssistant &&
            !state.seededWorkingAckPending &&
            shouldPublishAssistantUpdate({
              presentationMode: input.presentationMode ?? "full",
              streaming: true,
            })
          ) {
            // Rehydrate / live: turn is spinning (tools only) with no assistant bubble yet.
            // Keep or recreate a Working tip so Discord shows the turn is alive.
            const needsWorkingTip =
              mode === "rehydrate" ||
              !stateBefore.adoptedInitialSnapshot ||
              allStreamIds(state).length === 0;
            if (needsWorkingTip) {
              yield* Effect.logInfo("Ensuring Working tip for in-progress turn without assistant", {
                t3ThreadId: input.t3ThreadId,
                turnId: activeTurnId,
                mode,
                openTips: allStreamIds(state).length,
              });
              yield* postOrEditAssistant({
                turnId: activeTurnId,
                t3MessageId: REHYDRATE_WORKING_PLACEHOLDER_ID,
                text: "",
                streaming: true,
                images: [],
                worktreePath: thread.worktreePath,
              }).pipe(
                Effect.catchCause(alertStreamFailure("rehydrate-working-no-assistant")),
                Effect.asVoid,
              );
            }
          } else if (!turnRunningNoAssistant && !state.seededWorkingAckPending) {
            // A stopped/interrupted turn with no assistant content still needs to clear the
            // initial Working.. ack from Discord.
            yield* clearInProgressMessages("settled-without-assistant-message").pipe(
              Effect.catchCause(Effect.logError),
              Effect.asVoid,
            );
          }
        }

        // --- Secondary: title / pin / side posts (must not starve tip edits) ---
        // Best-effort + hard time budget: never fail the primary stream/finalize pass
        // because GH PR lookup / title / tasks hung (outer 90s TimeoutError left Discord
        // stuck on Working until the next chance event).
        yield* Effect.gen(function* () {
          yield* syncDiscordThreadTitle(thread);
          yield* syncThreadInfoModelPin(thread);

          // Tasks first: first-class Discord progress UI from turn.plan (not External User Input).
          // Keep updating mid-turn / rehydrate; owned via taskDiscordMessageId so it never freezes Working.
          const tasks = presentTasks(thread.activities, thread.latestTurn?.turnId ?? null);
          if (tasks !== null && input.presentationMode !== "final-only") {
            const content = formatTasksForDiscord(tasks);
            const key = `${tasks.explanation ?? ""}:${tasks.tasks.map((task) => `${task.status}:${task.step}`).join("|")}`;
            yield* postOrEditTasks(content, key).pipe(
              Effect.catchCause(Effect.logError),
              Effect.asVoid,
            );
          }

          // Cross-surface user text only (github / t3-client whitelist) — after Tasks.
          if (unseenExternalUserMessages.length > 0) {
            yield* postExternalUserMessages(unseenExternalUserMessages).pipe(
              Effect.catchCause(Effect.logError),
              Effect.asVoid,
            );
          }

          const pending = derivePendingInteractions(thread.activities);
          const approvals = pending.filter(
            (entry): entry is PendingApproval => entry.kind === "approval",
          );
          yield* postApprovals(approvals).pipe(Effect.catchCause(Effect.logError), Effect.asVoid);

          if (thread.session?.status === "error" && thread.session.lastError) {
            yield* rest
              .createMessage(input.discordChannelId, {
                content: `**T3 error:** ${thread.session.lastError}`,
              })
              .pipe(Effect.catchCause(Effect.logError), Effect.asVoid);
          }
        }).pipe(
          Effect.timeout(BRIDGE_SECONDARY_DISCORD_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.logWarning("Bridge secondary Discord work failed or timed out", {
              t3ThreadId: input.t3ThreadId,
              cause: formatAlertCause(cause, 300),
            }),
          ),
          Effect.asVoid,
        );
      }).pipe(Effect.asVoid);

    /**
     * Coalescing delivery queue.
     *
     * Previously every WS event awaited full Discord I/O inside Stream.runForEach.
     * A slow/hung createMessage blocked the subscription fiber, so later assistant
     * bubbles never reached Discord while the T3 client still advanced.
     *
     * Now: WS only publishes the latest snapshot + bumps a generation. A single
     * worker holds deliveryLock, always applies the newest snapshot, and loops if
     * more arrivals happened during Discord work.
     */
    const deliveryGenerationRef = yield* Ref.make(0);
    const deliveryProcessedRef = yield* Ref.make(0);
    const deliveryFailureCountRef = yield* Ref.make(0);
    const deliveryLock = yield* Semaphore.make(1);
    // Dual cursor: orchestration sequence observed from T3 (WS/HTTP), vs sequence
    // successfully applied to Discord after processThreadSnapshot.
    const latestObservedSequenceRef = yield* Ref.make<number | null>(
      persistedLink?.lastThreadSnapshotSequence ?? null,
    );
    const persistDeliverySequence = (sequence: number) =>
      links
        .updateBridgeHints(input.discordChannelId, {
          lastDeliveredSequence: sequence,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to persist delivery sequence cursor", {
              discordChannelId: input.discordChannelId,
              sequence,
              cause: formatAlertCause(cause, 300),
            }),
          ),
          Effect.asVoid,
        );

    /**
     * After processThreadSnapshot TimeoutError / failure: refresh from HTTP and keep
     * the delivery generation open so we retry instead of going silent until a new WS
     * event or the 12s reconcile tick.
     */
    const recoverAfterDeliveryFailure = (failureCount: number) =>
      Effect.gen(function* () {
        const backoffSec = deliveryFailureBackoffSeconds(failureCount);
        yield* Effect.logWarning("Bridge delivery auto-recover: backoff then HTTP reseed", {
          discordChannelId: input.discordChannelId,
          t3ThreadId: input.t3ThreadId,
          failureCount,
          backoffSec,
        });
        yield* Effect.sleep(`${backoffSec} seconds`);
        const snapshot = yield* t3.fetchThreadDetail(input.t3ThreadId as ThreadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Bridge delivery auto-recover fetch failed", {
              t3ThreadId: input.t3ThreadId,
              cause: formatAlertCause(cause, 300),
            }).pipe(Effect.as(null)),
          ),
        );
        if (snapshot === null) return;
        yield* Ref.set(latestObservedSequenceRef, snapshot.snapshotSequence);
        yield* links
          .updateBridgeHints(input.discordChannelId, {
            lastThreadSnapshotSequence: snapshot.snapshotSequence,
          })
          .pipe(Effect.catchCause(Effect.logWarning), Effect.asVoid);
        yield* Ref.set(latestThreadRef, snapshot.thread);
        // Bump generation so even if we marked the failed gen processed, a fresh
        // attempt is queued. Worker loop also continues when we leave processed behind.
        yield* Ref.update(deliveryGenerationRef, (n) => n + 1);
        yield* Effect.logInfo("Bridge delivery auto-recover reseeded snapshot", {
          t3ThreadId: input.t3ThreadId,
          sequence: snapshot.snapshotSequence,
          turnState: snapshot.thread.latestTurn?.state ?? null,
          messageCount: snapshot.thread.messages.length,
        });
      }).pipe(Effect.asVoid);

    const runDeliveryWorker = Effect.gen(function* () {
      while (true) {
        const pending = yield* Ref.get(deliveryGenerationRef);
        const processed = yield* Ref.get(deliveryProcessedRef);
        if (pending <= processed) return;
        const latest = yield* Ref.get(latestThreadRef);
        if (latest === null) {
          yield* Ref.set(deliveryProcessedRef, pending);
          return;
        }
        const processResult = yield* processThreadSnapshot(latest).pipe(
          // Outer safety net: stream timeouts above usually suffice; secondary work is
          // separately capped so title/tasks cannot burn this whole budget.
          Effect.timeout(BRIDGE_PROCESS_SNAPSHOT_TIMEOUT),
          Effect.result,
        );
        if (Result.isFailure(processResult)) {
          const pretty = formatAlertCause(processResult.failure);
          const failureCount = yield* Ref.updateAndGet(deliveryFailureCountRef, (n) => n + 1);
          yield* Effect.logError("Thread bridge processThreadSnapshot failed", {
            discordChannelId: input.discordChannelId,
            t3ThreadId: input.t3ThreadId,
            failureCount,
            cause: pretty,
          });
          // Alert on first failure and every 5th thereafter so recover loops are not spam.
          if (failureCount === 1 || failureCount % 5 === 0) {
            yield* postBridgeAlert(
              `onThread:${input.discordChannelId}`,
              "Thread bridge processThreadSnapshot failed (auto-recovering)",
              [
                `channel=\`${input.discordChannelId}\``,
                `thread=\`${input.t3ThreadId}\``,
                `mode=\`${mode}\``,
                `failureCount=${failureCount}`,
                pretty,
              ].join("\n"),
            );
          }
          // Do not advance lastDeliveredSequence — delivery lag keeps HTTP reconcile on.
          // Close this generation, reseed from HTTP (backoff), bump a new generation, retry.
          yield* Ref.set(deliveryProcessedRef, pending);
          if (
            shouldRetryDeliveryFailure({
              failureCount,
              maxRetries: BRIDGE_DELIVERY_FAILURE_MAX_RETRIES,
            })
          ) {
            yield* recoverAfterDeliveryFailure(failureCount);
            continue;
          }
          // Exhausted in-worker retries — one last reseed, reset counter, defer further
          // attempts to the 12s HTTP reconcile fiber (open tips / delivery lag).
          yield* Effect.logError(
            "Bridge delivery auto-recover exhausted in-worker retries; deferring to HTTP reconcile",
            {
              discordChannelId: input.discordChannelId,
              t3ThreadId: input.t3ThreadId,
              failureCount,
            },
          );
          yield* recoverAfterDeliveryFailure(failureCount);
          yield* Ref.set(deliveryFailureCountRef, 0);
          continue;
        }

        yield* Ref.set(deliveryFailureCountRef, 0);
        // Snapshot applied to Discord (stream/finalize/noop). Advance delivery cursor
        // to the latest orchestration sequence we have observed for this thread.
        const observed = yield* Ref.get(latestObservedSequenceRef);
        if (observed !== null && Number.isFinite(observed)) {
          yield* persistDeliverySequence(observed);
          // Durable warm base (trimmed) for restart resume without full HTTP tip.
          yield* persistWarmThreadCache(latest, observed);
        }
        // Mark the generation we *started* with as done; if newer arrived mid-run,
        // the loop continues and re-applies the latest snapshot.
        yield* Ref.set(deliveryProcessedRef, pending);
      }
    });

    const scheduleThreadDelivery = (thread: OrchestrationThread) =>
      Effect.gen(function* () {
        // Unblock BridgeHub.ensure as soon as any snapshot arrives (do not wait for Discord).
        yield* signalReady;
        const bridgeState = yield* Ref.get(stateRef);
        if (bridgeState.delivery.lastFinalizedAssistantId !== null) {
          deliveredMemoryTrim.lastFinalizedAssistantId =
            bridgeState.delivery.lastFinalizedAssistantId;
        }
        yield* Ref.set(latestThreadRef, projectThreadForDiscordMemory(thread));
        yield* Ref.update(deliveryGenerationRef, (n) => n + 1);
        yield* deliveryLock.withPermit(runDeliveryWorker).pipe(Effect.forkDetach);
      });

    const heartbeatFiber =
      input.presentationMode === "final-only"
        ? null
        : yield* Effect.gen(function* () {
            let workingDots: WorkingDotCount = 2;
            while (true) {
              yield* Effect.sleep("10 seconds");
              workingDots = nextWorkingDotCount(workingDots);
              yield* updateWorkingHeartbeat(workingDots).pipe(
                Effect.catchCause((cause) =>
                  Effect.gen(function* () {
                    const pretty = formatAlertCause(cause);
                    yield* Effect.logWarning("Failed to update Discord Working heartbeat", {
                      discordChannelId: input.discordChannelId,
                      t3ThreadId: input.t3ThreadId,
                      cause: pretty,
                    });
                    yield* postBridgeAlert(
                      `heartbeat:${input.discordChannelId}`,
                      "Working heartbeat failed",
                      [
                        `channel=\`${input.discordChannelId}\``,
                        `thread=\`${input.t3ThreadId}\``,
                        pretty,
                      ].join("\n"),
                    );
                  }).pipe(Effect.asVoid),
                ),
              );
            }
          }).pipe(Effect.forkChild);

    /**
     * HTTP reconcile: when Working tips stay open or a turn is running, re-fetch the
     * thread over HTTP even if the WS stream has gone quiet. This is the recovery path
     * for "T3 client has the answer, Discord still says Working..".
     */
    const reconcileFiber = yield* Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(BRIDGE_HTTP_RECONCILE_INTERVAL);
        const state = yield* Ref.get(stateRef);
        const latest = yield* Ref.get(latestThreadRef);
        const openStreamTipCount = allStreamIds(state).length;
        const turnInProgress = latest !== null && isTurnInProgress(latest);
        // We started work from Discord (user message and/or Working ack) but never
        // recorded a finalize for the current turn — keep reconciling until we do.
        const awaitingDiscordFinal =
          state.finalizedTurnId === null &&
          (state.seededWorkingAckPending ||
            state.sentDiscordUserMessageIds.length > 0 ||
            openStreamTipCount > 0);
        const linkCursors = yield* links
          .getByDiscordThreadId(input.discordChannelId)
          .pipe(Effect.catchCause(() => Effect.succeed(null)));
        const deliveryLagging = isDeliveryBehindOrchestration({
          lastDeliveredSequence:
            linkCursors?.lastDeliveredSequence ?? persistedLink?.lastDeliveredSequence ?? null,
          lastThreadSnapshotSequence:
            (yield* Ref.get(latestObservedSequenceRef)) ??
            linkCursors?.lastThreadSnapshotSequence ??
            persistedLink?.lastThreadSnapshotSequence ??
            null,
        });
        if (
          !bridgeNeedsHttpReconcile({
            openStreamTipCount,
            seededWorkingAckPending: state.seededWorkingAckPending,
            turnInProgress,
            awaitingDiscordFinal,
            deliveryLagging,
          })
        ) {
          continue;
        }

        const snapshot = yield* t3.fetchThreadDetail(input.t3ThreadId as ThreadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Bridge HTTP reconcile fetch failed", {
              t3ThreadId: input.t3ThreadId,
              cause: formatAlertCause(cause, 300),
            }).pipe(Effect.as(null)),
          ),
        );
        if (snapshot === null) continue;

        yield* Effect.logInfo("Bridge HTTP reconcile applying snapshot", {
          t3ThreadId: input.t3ThreadId,
          sequence: snapshot.snapshotSequence,
          openStreamTipCount,
          turnState: snapshot.thread.latestTurn?.state ?? null,
          sessionStatus: snapshot.thread.session?.status ?? null,
          messageCount: snapshot.thread.messages.length,
          awaitingDiscordFinal,
          deliveryLagging,
        });
        // Orchestration cursor only — delivery cursor advances after process succeeds.
        yield* Ref.set(latestObservedSequenceRef, snapshot.snapshotSequence);
        yield* links
          .updateBridgeHints(input.discordChannelId, {
            lastThreadSnapshotSequence: snapshot.snapshotSequence,
          })
          .pipe(Effect.catchCause(Effect.logWarning), Effect.asVoid);
        yield* scheduleThreadDelivery(snapshot.thread);
      }
    }).pipe(Effect.forkChild);

    // botUserId is used for finalize accept-without-ack adoption scans.

    const storedSequence = persistedLink?.lastThreadSnapshotSequence ?? null;
    const storedDeliveredSequence = persistedLink?.lastDeliveredSequence ?? null;
    const initialAfterSequence = resolveSubscribeAfterSequence({
      lastDeliveredSequence: storedDeliveredSequence,
      lastThreadSnapshotSequence: storedSequence,
    });
    const subscribeSeed = resolveThreadSubscribeSeed({
      warm:
        warmCacheEntry !== null
          ? {
              snapshotSequence: warmCacheEntry.snapshotSequence,
              thread: warmCacheEntry.thread,
            }
          : null,
      afterSequence: initialAfterSequence,
    });
    yield* Effect.logInfo("Bridge subscribing to T3 thread stream", {
      t3ThreadId: input.t3ThreadId,
      storedSequence,
      storedDeliveredSequence,
      afterSequence: initialAfterSequence,
      seedKind: subscribeSeed.kind,
      warmSequence: warmCacheEntry?.snapshotSequence ?? null,
      warmMessageCount: warmCacheEntry?.thread.messages.length ?? null,
      deliveryLagging: isDeliveryBehindOrchestration({
        lastDeliveredSequence: storedDeliveredSequence,
        lastThreadSnapshotSequence: storedSequence,
      }),
    });
    // WS callback only enqueues; Discord I/O runs on the delivery worker.
    const onThreadGuarded = (thread: OrchestrationThread) =>
      scheduleThreadDelivery(thread).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const pretty = formatAlertCause(cause);
            yield* Effect.logError("Thread bridge scheduleThreadDelivery failed", {
              discordChannelId: input.discordChannelId,
              t3ThreadId: input.t3ThreadId,
              cause: pretty,
            });
            yield* postBridgeAlert(
              `onThread:${input.discordChannelId}`,
              "Thread bridge scheduleThreadDelivery failed",
              [
                `channel=\`${input.discordChannelId}\``,
                `thread=\`${input.t3ThreadId}\``,
                `mode=\`${mode}\``,
                pretty,
              ].join("\n"),
            );
          }).pipe(Effect.asVoid),
        ),
      );

    // Orchestration cursor: advances as soon as T3 state is observed (performant WS
    // resume). Delivery cursor is separate and only moves after Discord I/O succeeds.
    // Both are O(1) scalars — never an event/history log.
    const persistSequenceMarker = (sequence: number) =>
      Effect.gen(function* () {
        yield* Ref.set(latestObservedSequenceRef, sequence);
        yield* links.updateBridgeHints(input.discordChannelId, {
          lastThreadSnapshotSequence: sequence,
        });
      }).pipe(Effect.asVoid);

    // Client-aligned follow (DiscordThreadFollower) + durable warm tip:
    // prefer warm base + afterSequence (web/desktop EnvironmentCacheStore pattern);
    // HTTP full tip only when warm is missing. Dual-cursor afterSequence prefers
    // delivery high-water. Follower owns reload-required + durable resubscribe.
    // ResponseBridge only projects OrchestrationThread → Discord (coalesce queue).
    const warmForSubscribe = yield* warmCache
      .load(input.t3ThreadId)
      .pipe(Effect.catchCause(() => Effect.succeed(null)));
    const seed = resolveThreadSubscribeSeed({
      warm:
        warmForSubscribe !== null
          ? {
              snapshotSequence: warmForSubscribe.snapshotSequence,
              thread: warmForSubscribe.thread,
            }
          : null,
      afterSequence: initialAfterSequence,
    });
    yield* t3
      .subscribeThread(input.t3ThreadId as ThreadId, onThreadGuarded, {
        ...(seed.kind === "warm"
          ? {
              afterSequence: seed.afterSequence,
              warmSeed: {
                snapshotSequence: seed.afterSequence,
                thread: seed.thread,
              },
            }
          : seed.kind === "http"
            ? { afterSequence: seed.afterSequence }
            : initialAfterSequence !== null && initialAfterSequence >= 0
              ? { afterSequence: initialAfterSequence }
              : {}),
        onSequence: persistSequenceMarker,
        projectThread: projectThreadForDiscordMemory,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            // Follower retries internally; this is only if the outer effect is interrupted
            // or fails without recovery.
            const pretty = formatAlertCause(cause);
            yield* Effect.logError("Bridge subscribeThread exited", {
              discordChannelId: input.discordChannelId,
              t3ThreadId: input.t3ThreadId,
              cause: pretty,
            });
            yield* postFatalAlert(
              `subscribe:${input.t3ThreadId}`,
              "T3 thread subscription exited",
              `channel=\`${input.discordChannelId}\` thread=\`${input.t3ThreadId}\`\n${pretty}`,
            );
          }).pipe(Effect.asVoid),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            if (heartbeatFiber !== null) {
              yield* Fiber.interrupt(heartbeatFiber).pipe(Effect.ignore);
            }
            yield* Fiber.interrupt(reconcileFiber).pipe(Effect.ignore);
            yield* stopVcsStatusSubscription;
            // Do NOT delete open stream tips on stop when the turn is still running.
            // Restart/reconnect must leave Working.. visible so rehydrate can resume it.
            // Interactive re-ensure already orphan-cleans via seedStreamMessageIds when a
            // fresh Working ack is posted for a new user turn.
            const state = yield* Ref.get(stateRef);
            const latest = yield* Ref.get(latestThreadRef);
            const openTips = allStreamIds(state);
            const turnRunning = latest !== null && isTurnInProgress(latest);
            if (
              shouldPreserveStreamTipsOnBridgeStop({
                turnInProgress: turnRunning,
                openStreamTipCount: openTips.length,
              })
            ) {
              yield* Effect.logInfo(
                "Discord↔T3 bridge stopped; preserving in-progress stream tips for rehydrate",
                {
                  discordChannelId: input.discordChannelId,
                  t3ThreadId: input.t3ThreadId,
                  tipIds: openTips,
                  turnState: latest?.latestTurn?.state ?? null,
                },
              );
            } else if (openTips.length > 0) {
              // Idle bridge replacement: drop leftover tips so they do not linger.
              yield* streamWriteLock.withPermit(deleteMessages(openTips));
              yield* persistStreamMessageIds([]);
              yield* Effect.logInfo("Discord↔T3 bridge stopped; cleared idle stream tips", {
                discordChannelId: input.discordChannelId,
                t3ThreadId: input.t3ThreadId,
                tipIds: openTips,
              });
            } else {
              yield* Effect.logInfo("Discord↔T3 bridge stopped", {
                discordChannelId: input.discordChannelId,
                t3ThreadId: input.t3ThreadId,
              });
            }
          }),
        ),
      );
  });
