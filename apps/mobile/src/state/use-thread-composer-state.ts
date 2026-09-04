import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert } from "react-native";
import * as Cause from "effect/Cause";

import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { sendEntersSteeringQueue } from "@t3tools/shared/chatList";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import { isModelSelectionUnavailable } from "../lib/modelOptions";
import { resolveProviderInteractionMode } from "../features/threads/legacy-plan-mode";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerFiles,
  pickComposerMedia,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import {
  defaultFetchAttachmentDataUrl,
  describeQueuedAttachmentCapacity,
  formatMissingAttachmentsError,
  recallQueuedAttachments,
} from "../lib/queuedAttachmentRecall";
import { scopedThreadKey } from "../lib/scopedEntities";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { buildThreadFeed, promoteSteeredQueuedMessages } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  removeComposerDraftAttachment,
  scheduleUnusedComposerAttachmentCleanup,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
} from "../state/use-remote-environment-registry";
import { useAssetUrls } from "../state/assets";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { enqueueThreadOutboxMessage } from "./thread-outbox";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import { dispatchingQueuedMessageIdAtom, useThreadOutboxMessages } from "./use-thread-outbox";
import { threadEnvironment } from "./threads";
import { useAtomCommand } from "./use-atom-command";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "./composer-attachment-uploads";

const EMPTY_MESSAGE_ID_SET: ReadonlySet<MessageId> = new Set();

/** Set-minus that keeps the current reference when nothing was removed. */
function pruneSteeringQueuedMessageIds(
  current: ReadonlySet<MessageId>,
  resolved: ReadonlySet<MessageId>,
): ReadonlySet<MessageId> {
  if (current.size === 0 || resolved.size === 0) {
    return current;
  }
  const next = new Set<MessageId>();
  for (const messageId of current) {
    if (!resolved.has(messageId)) {
      next.add(messageId);
    }
  }
  return next.size === current.size ? current : next;
}

/**
 * Steered ids the server no longer holds in the queue. That is the settle
 * signal for the optimistic overlay: dispatched (now a real message) or gone.
 */
function resolvedSteeredMessageIds(
  steering: ReadonlySet<MessageId>,
  queuedMessages: ReadonlyArray<{ readonly messageId: MessageId }> | undefined,
): ReadonlySet<MessageId> {
  if (steering.size === 0) {
    return EMPTY_MESSAGE_ID_SET;
  }
  const stillQueued = new Set((queuedMessages ?? []).map((message) => message.messageId));
  const resolved = new Set<MessageId>();
  for (const messageId of steering) {
    if (!stillQueued.has(messageId)) {
      resolved.add(messageId);
    }
  }
  return resolved;
}

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const existing = appAtomRegistry.get(composerDraftsAtom)[threadKey]?.text ?? "";
  const separator = existing.trim().length > 0 && !existing.endsWith("\n") ? "\n\n" : "";
  setComposerDraftText(threadKey, `${existing}${separator}${input.text}`);
  if (input.attachments && input.attachments.length > 0) {
    // Capped: a review comment is new content, not a send-failure restore, so
    // it must not push the draft over the send limit. Overflow is released.
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments);
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftAttachments: draft.attachments,
  };
}

export function useThreadComposerState() {
  const { selectedThread: selectedThreadShell, selectedEnvironmentRuntime } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const { connectedEnvironments } = useRemoteConnectionStatus();
  // Server-queued messages the user sent now, until the dispatch lands (or a
  // failure puts them back in the queue).
  const [steeringQueuedMessageIds, setSteeringQueuedMessageIds] =
    useState<ReadonlySet<MessageId>>(EMPTY_MESSAGE_ID_SET);
  const dispatchingQueuedMessageId = useAtomValue(dispatchingQueuedMessageIdAtom);
  const [feedbackSubmissionsByThreadKey, setFeedbackSubmissionsByThreadKey] = useState<
    Record<string, ReadonlyArray<CodexFeedbackSubmission>>
  >({});
  const uploadThreadFeedback = useAtomCommand(threadEnvironment.uploadFeedback, {
    reportFailure: false,
  });

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;

  // Resolved once the server stops listing it as queued: the dispatch landed
  // and it is a real timeline message from here on, so stop overlaying it.
  const serverQueuedMessages = selectedThreadDetail?.queuedMessages;
  useEffect(() => {
    setSteeringQueuedMessageIds((existing) =>
      pruneSteeringQueuedMessageIds(
        existing,
        resolvedSteeredMessageIds(existing, serverQueuedMessages),
      ),
    );
  }, [serverQueuedMessages]);

  // Optimistic overlays never survive a thread switch.
  useEffect(() => {
    setSteeringQueuedMessageIds(EMPTY_MESSAGE_ID_SET);
  }, [selectedThreadKey]);
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );
  const steerQueuedMessage = useAtomCommand(threadEnvironment.steerQueuedMessage, {
    label: "steer queued message",
  });
  const removeServerQueuedMessage = useAtomCommand(threadEnvironment.removeQueuedMessage, {
    label: "remove queued message",
  });
  // "Send now" promotes a queued message into the conversation before the
  // server confirms the dispatch; the chip goes with it. See
  // promoteSteeredQueuedMessages.
  const steeredDetail = useMemo(
    () =>
      selectedThreadDetail
        ? promoteSteeredQueuedMessages(selectedThreadDetail, steeringQueuedMessageIds)
        : selectedThreadDetail,
    [selectedThreadDetail, steeringQueuedMessageIds],
  );

  const localFeedbackMessages = useMemo(() => {
    const submissions = selectedThreadKey
      ? (feedbackSubmissionsByThreadKey[selectedThreadKey] ?? [])
      : [];
    return submissions.flatMap((submission) =>
      submission.status === "interrupted"
        ? []
        : [codexFeedbackMessage(submission), codexFeedbackMessage(submission, "assistant")],
    );
  }, [feedbackSubmissionsByThreadKey, selectedThreadKey]);
  const selectedThreadMessages = steeredDetail?.messages;
  const selectedThreadActivities = steeredDetail?.activities;
  const selectedThreadFeed = useMemo(
    () =>
      selectedThreadMessages && selectedThreadActivities
        ? buildThreadFeed(
            { messages: selectedThreadMessages, activities: selectedThreadActivities },
            { localMessages: localFeedbackMessages },
          )
        : [],
    [localFeedbackMessages, selectedThreadActivities, selectedThreadMessages],
  );

  const composerQueueItems = useMemo(() => {
    type QueueItem = {
      readonly messageId: MessageId;
      readonly text: string;
      readonly attachmentCount: number;
      readonly deliveryState: "waiting" | "sending" | "queued";
      readonly queueSource: "local" | "server";
      readonly sortAt: string;
    };
    const byId = new Map<MessageId, QueueItem>();
    // Includes optimistically steered messages, so their chips go immediately.
    const timelineIds = new Set(steeredDetail?.messages.map((message) => message.id) ?? []);

    for (const message of steeredDetail?.queuedMessages ?? []) {
      if (timelineIds.has(message.messageId)) continue;
      byId.set(message.messageId, {
        messageId: message.messageId,
        text: message.text,
        attachmentCount: message.attachments.length,
        deliveryState: "queued",
        queueSource: "server",
        sortAt: message.queuedAt,
      });
    }

    // Local outbox wins for the same id until the ack removes it (sending →
    // queued transition without a double chip).
    for (const message of selectedThreadQueuedMessages) {
      if (timelineIds.has(message.messageId)) continue;
      byId.set(message.messageId, {
        messageId: message.messageId,
        text: message.text,
        attachmentCount: message.attachments.length,
        queueSource: "local",
        deliveryState: connectedEnvironments.some(
          (environment) =>
            environment.environmentId === message.environmentId &&
            environment.connectionState === "connected",
        )
          ? "sending"
          : "waiting",
        sortAt: message.createdAt,
      });
    }

    return Array.from(byId.values()).sort((left, right) => left.sortAt.localeCompare(right.sortAt));
  }, [connectedEnvironments, steeredDetail, selectedThreadQueuedMessages]);

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const selectedThreadQueueCount = selectedThreadQueuedMessages.length;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const selectedProvider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
    (provider) => provider.instanceId === modelSelection?.instanceId,
  );
  const interactionMode = selectedThread
    ? resolveProviderInteractionMode(
        selectedProvider,
        selectedDraft?.interactionMode ?? selectedThread.interactionMode,
      )
    : null;

  const selectedThreadSessionActivity = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread?.session) {
      return null;
    }

    return {
      orchestrationStatus: selectedThread.session.status,
      activeTurnId: selectedThread.session.activeTurnId ?? undefined,
    };
  }, [selectedThreadDetail, selectedThreadShell]);

  const isCompacting = useMemo(() => {
    const queuedMessage = selectedThreadQueuedMessages.findLast(
      (message) =>
        message.messageId === dispatchingQueuedMessageId &&
        message.text.trim().toLowerCase() === "/compact" &&
        message.attachments.length === 0,
    );
    const latestCompactMessage = selectedThreadDetail?.messages.findLast(
      (message) =>
        message.role === "user" &&
        message.text.trim().toLowerCase() === "/compact" &&
        !message.attachments?.length,
    );
    const compactRequestIsActive =
      latestCompactMessage !== undefined &&
      (latestCompactMessage.createdAt >
        (selectedThread?.latestTurn?.requestedAt ?? latestCompactMessage.createdAt) ||
        (selectedThread?.latestTurn?.state === "running" &&
          latestCompactMessage.createdAt === selectedThread.latestTurn.requestedAt));
    const compactionSettled = selectedThreadDetail?.activities.some((activity) => {
      if (!["context-compaction", "provider.turn.start.failed"].includes(activity.kind))
        return false;
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as { readonly requestId?: unknown })
          : null;
      return payload?.requestId === latestCompactMessage?.id;
    });
    return (
      queuedMessage !== undefined ||
      ((selectedThread?.session?.status === "starting" ||
        selectedThread?.session?.status === "running") &&
        compactRequestIsActive &&
        !compactionSettled)
    );
  }, [
    dispatchingQueuedMessageId,
    selectedThread,
    selectedThreadDetail,
    selectedThreadQueuedMessages,
  ]);

  const activeWorkStartedAt = useMemo(() => {
    const selectedThread = selectedThreadDetail ?? selectedThreadShell;
    if (!selectedThread) {
      return null;
    }

    return deriveActiveWorkStartedAt(
      selectedThread.latestTurn,
      selectedThreadSessionActivity,
      null,
    );
  }, [selectedThreadDetail, selectedThreadSessionActivity, selectedThreadShell]);

  // A send made now would be held in the steering queue rather than opening a
  // turn, so it becomes a composer chip and must not move the feed. Threads on
  // this screen already exist server-side, so no send here is a bootstrap.
  const sendEntersQueue = sendEntersSteeringQueue({
    hasBootstrap: false,
    sessionStatus: selectedThread?.session?.status,
    hasPendingTurnStart: (selectedThreadDetail?.pendingTurnStart ?? null) !== null,
  });

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (
      composerAttachmentUploadBlockReason({
        environmentId: selectedThreadShell.environmentId,
        attachments,
        connected: selectedEnvironmentRuntime?.connectionState === "connected",
        serverConfig: selectedEnvironmentRuntime?.serverConfig ?? null,
        states: appAtomRegistry.get(composerAttachmentUploadsAtom),
      }) !== null
    )
      return null;
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }
    // A send-failure restore appends with allowOverflow so it never drops the
    // user's files, which can leave the draft over the cap. Sending it anyway
    // would enqueue a message that outbox recovery rejects forever, so block
    // here until the user removes attachments.
    if (attachments.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      Alert.alert(
        "Too many attachments",
        `Remove attachments until there are at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}.`,
      );
      return null;
    }

    const modelSelection = draft.modelSelection ?? thread.modelSelection;
    const serverConfig = selectedEnvironmentRuntime?.serverConfig;
    if (
      selectedEnvironmentRuntime?.connectionState === "connected" &&
      isModelSelectionUnavailable(serverConfig, modelSelection)
    ) {
      Alert.alert(
        "Antigravity model unavailable",
        "Open model settings to finish setup or choose another model.",
      );
      return null;
    }
    const provider = serverConfig?.providers.find(
      (entry) => entry.instanceId === modelSelection.instanceId,
    );
    const feedbackCommand =
      attachments.length === 0 &&
      (provider?.driver === "codex" || thread.session?.providerName === "codex")
        ? parseCodexFeedbackCommand(text)
        : null;
    if (feedbackCommand) {
      if (thread.session === null) {
        Alert.alert("Start a Codex thread first", "Send a message before you submit feedback.");
        return null;
      }
      const metadata = makeQueuedMessageMetadata();
      const result = await submitCodexFeedback({
        submission: {
          id: MessageId.make(metadata.messageId),
          command: text,
          createdAt: metadata.createdAt,
        },
        clearDraft: () => clearComposerDraftContent(threadKey),
        onUpdate: (submission) => {
          setFeedbackSubmissionsByThreadKey((current) => {
            const existing = current[threadKey] ?? [];
            const found = existing.some((entry) => entry.id === submission.id);
            return {
              ...current,
              [threadKey]: found
                ? existing.map((entry) => (entry.id === submission.id ? submission : entry))
                : [...existing, submission],
            };
          });
        },
        upload: () =>
          uploadThreadFeedback({
            environmentId: selectedThreadShell.environmentId,
            input: {
              threadId: selectedThreadShell.id,
              ...feedbackCommand,
            },
          }),
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return null;
        }
        const error = Cause.squash(result.cause);
        Alert.alert(
          "Could not send feedback to OpenAI",
          error instanceof Error ? error.message : "An error occurred.",
        );
        return null;
      }
      const feedbackId = result.value.feedbackId;
      Alert.alert("Feedback sent to OpenAI", `Thread ID: ${feedbackId}`, [
        { text: "OK", style: "cancel" },
        {
          text: "Copy ID",
          onPress: () => copyTextWithHaptic(feedbackId, { target: "Codex feedback thread ID" }),
        },
      ]);
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    // Enqueue updates the in-memory outbox synchronously so the feed can paint
    // "Sending" before disk I/O finishes. Clear the draft in the same turn and
    // return immediately — durability trails off the critical path.
    const enqueuePromise = enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: resolveProviderInteractionMode(
        provider,
        draft.interactionMode ?? thread.interactionMode,
      ),
      createdAt: metadata.createdAt,
    });
    clearComposerDraftContent(threadKey, { deferAttachmentCleanup: true });
    enqueuePromise.then(
      () => {
        // The queued message owns the files now; the sweep sees that and
        // spares them. Deferred to here so a failed write cannot roll the
        // message out of the queue mid-sweep and lose the bytes.
        scheduleUnusedComposerAttachmentCleanup(attachments);
      },
      (error: unknown) => {
        // Restore text via merge (idempotent) but attachments via the uncapped
        // append: the merge path slots existing attachments first and truncates
        // at the send limit, which would silently drop this message's images if
        // the user attached new ones while the write was in flight.
        void mergeComposerDraftContent(threadKey, { text, attachments: [] });
        appendComposerDraftAttachments(threadKey, attachments, { allowOverflow: true });
        setPendingConnectionError(
          error instanceof Error ? error.message : "Failed to save the queued message.",
        );
      },
    );
    return messageId;
  }, [
    selectedEnvironmentRuntime?.connectionState,
    selectedEnvironmentRuntime?.serverConfig,
    selectedThreadDetail,
    selectedThreadShell,
    uploadThreadFeedback,
  ]);

  const onSteerQueuedMessage = useCallback(
    async (messageId: MessageId) => {
      if (!selectedThreadShell || steeringQueuedMessageIds.has(messageId)) {
        return;
      }
      // Into the conversation up front; the chip goes with it.
      setSteeringQueuedMessageIds((existing) => new Set(existing).add(messageId));
      const result = await steerQueuedMessage({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id, messageId },
      });
      if (result._tag === "Success") {
        return;
      }
      // Back to the queue. The decider rejects a steer that races a pending
      // turn start, so this is a reachable path, not just transport failure.
      // Interruption reverts too — a steer that did land re-settles on the
      // next projection.
      setSteeringQueuedMessageIds((existing) =>
        pruneSteeringQueuedMessageIds(existing, new Set([messageId])),
      );
      if (!isAtomCommandInterrupted(result)) {
        setPendingConnectionError("Failed to send the queued message now.");
      }
    },
    [selectedThreadShell, steerQueuedMessage, steeringQueuedMessageIds],
  );

  // Server-queued attachments are resolved up front so editing one can put its
  // pictures back in the composer; the bytes only exist behind a signed URL.
  const serverQueuedAttachmentIds = useMemo(() => {
    const attachmentIds = new Set<string>();
    for (const queued of serverQueuedMessages ?? []) {
      for (const attachment of queued.attachments) {
        attachmentIds.add(attachment.id);
      }
    }
    return [...attachmentIds];
  }, [serverQueuedMessages]);
  const serverQueuedAttachmentResources = useMemo(
    () =>
      serverQueuedAttachmentIds.map((attachmentId) => ({
        _tag: "attachment" as const,
        attachmentId,
      })),
    [serverQueuedAttachmentIds],
  );
  const serverQueuedAttachmentUrls = useAssetUrls(
    selectedThreadShell?.environmentId ?? null,
    serverQueuedAttachmentResources,
  );
  const serverQueuedAttachmentUrlById = useMemo(
    () =>
      new Map(
        serverQueuedAttachmentIds.flatMap((attachmentId, index) => {
          const url = serverQueuedAttachmentUrls[index];
          return url ? [[attachmentId, url] as const] : [];
        }),
      ),
    [serverQueuedAttachmentIds, serverQueuedAttachmentUrls],
  );

  const onEditQueuedMessage = useCallback(
    async (messageId: MessageId, source: "local" | "server") => {
      if (!selectedThreadShell) {
        return;
      }
      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      if (source === "local") {
        const message = selectedThreadQueuedMessages.find(
          (candidate) => candidate.messageId === messageId,
        );
        if (!message) return;
        try {
          await removeThreadOutboxMessage(message);
        } catch (error) {
          setPendingConnectionError(
            error instanceof Error
              ? error.message
              : "Failed to remove the queued message for editing.",
          );
          return;
        }
        setComposerDraftText(threadKey, message.text);
        if (message.attachments.length > 0) {
          appendComposerDraftAttachments(threadKey, message.attachments);
        }
      } else {
        const message = selectedThreadDetail?.queuedMessages.find(
          (candidate) => candidate.messageId === messageId,
        );
        if (!message) return;
        // Removing a queued message deletes its attachment files on the server,
        // so everything that could lose a picture happens before the removal and
        // backs out of the whole edit instead.
        const capacityError = describeQueuedAttachmentCapacity(
          message.attachments.length,
          getComposerDraftSnapshot(threadKey).attachments.length,
        );
        if (capacityError !== null) {
          setPendingConnectionError(capacityError);
          return;
        }
        const recalled = await recallQueuedAttachments(message.attachments, {
          urlById: serverQueuedAttachmentUrlById,
          fetchDataUrl: defaultFetchAttachmentDataUrl,
        });
        // Signed URLs resolve asynchronously, so an edit tapped early — or one
        // that hits a network blip — finds nothing to read. Leave the message
        // queued: it and its pictures are intact, and the edit can be retried.
        const missingError = formatMissingAttachmentsError(recalled.missing);
        if (missingError !== null) {
          setPendingConnectionError(missingError);
          return;
        }
        const result = await removeServerQueuedMessage({
          environmentId: selectedThreadShell.environmentId,
          input: { threadId: selectedThreadShell.id, messageId },
        });
        if (result._tag !== "Success") return;
        setComposerDraftText(threadKey, message.text);
        if (recalled.images.length > 0) {
          appendComposerDraftAttachments(threadKey, recalled.images);
        }
      }
    },
    [
      removeServerQueuedMessage,
      selectedThreadDetail,
      selectedThreadQueuedMessages,
      selectedThreadShell,
      serverQueuedAttachmentUrlById,
    ],
  );

  const onChangeDraftMessage = useCallback(
    (value: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      setComposerDraftText(threadKey, value);
    },
    [selectedThreadShell],
  );

  const onPickDraftMedia = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const capabilities = selectedEnvironmentRuntime?.serverConfig?.environment.capabilities;
    const result = await pickComposerMedia({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxVideoBytes:
        capabilities?.attachmentUploads === true
          ? capabilities.fileAttachments?.maxUploadBytes
          : undefined,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.attachments);
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach photo or video", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPickDraftFiles = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }
    const maxBytes =
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.fileAttachments
        ?.maxUploadBytes;
    if (maxBytes === undefined) {
      Alert.alert("Could not attach file", "This server does not support file attachments.");
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    // pickComposerFiles clamps the advertised limit to the contract maximum.
    const result = await pickComposerFiles({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
      maxBytes,
    });
    const rejectedCount = appendComposerDraftAttachments(threadKey, result.files);
    // The picker error and the live-cap rejection can both happen in one
    // pick; report both in a single alert.
    const problems = [
      ...(result.error ? [result.error] : []),
      ...(rejectedCount > 0
        ? [`You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`]
        : []),
    ];
    if (problems.length > 0) {
      Alert.alert("Could not attach file", problems.join("\n\n"));
    }
  }, [composerDrafts, selectedEnvironmentRuntime?.serverConfig, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    const rejectedPasteCount = appendComposerDraftAttachments(threadKey, result.images);
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    } else if (rejectedPasteCount > 0) {
      setPendingConnectionError(
        `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} files per message.`,
      );
    }
  }, [composerDrafts, selectedThreadShell]);

  const onNativePasteImages = useCallback(
    async (uris: ReadonlyArray<string>) => {
      if (!selectedThreadShell || uris.length === 0) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      try {
        const images = await convertPastedImagesToAttachments({
          uris,
          existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
        });
        if (images.length > 0) {
          appendComposerDraftAttachments(threadKey, images);
        }
      } catch (error) {
        console.error("[native paste] error converting images", {
          environmentId: selectedThreadShell.environmentId,
          threadId: selectedThreadShell.id,
          uriCount: uris.length,
          ...safeErrorLogAttributes(error),
        });
      }
    },
    [composerDrafts, selectedThreadShell],
  );

  const onRemoveDraftImage = useCallback(
    (imageId: string) => {
      if (!selectedThreadShell) {
        return;
      }

      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      removeComposerDraftAttachment(threadKey, imageId);
    },
    [selectedThreadShell],
  );

  const onUpdateModelSelection = useCallback(
    (value: ModelSelection) => {
      if (!selectedThreadKey) {
        return;
      }
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === value.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        modelSelection: value,
        ...(provider?.showInteractionModeToggle === false
          ? { interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE }
          : {}),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThreadKey],
  );

  const onUpdateRuntimeMode = useCallback(
    (value: RuntimeMode) => {
      if (!selectedThreadKey) {
        return;
      }
      updateComposerDraftSettings(selectedThreadKey, { runtimeMode: value });
    },
    [selectedThreadKey],
  );

  const onUpdateInteractionMode = useCallback(
    (value: ProviderInteractionMode) => {
      if (!selectedThreadKey) {
        return;
      }
      const modelSelection =
        getComposerDraftSnapshot(selectedThreadKey).modelSelection ??
        selectedThread?.modelSelection;
      const provider = selectedEnvironmentRuntime?.serverConfig?.providers.find(
        (candidate) => candidate.instanceId === modelSelection?.instanceId,
      );
      updateComposerDraftSettings(selectedThreadKey, {
        interactionMode: resolveProviderInteractionMode(provider, value),
      });
    },
    [selectedEnvironmentRuntime?.serverConfig, selectedThread?.modelSelection, selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    selectedThreadQueueCount,
    composerQueueItems,
    activeWorkStartedAt,
    isCompacting,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    sendEntersQueue,
    onChangeDraftMessage,
    onPickDraftMedia,
    onPickDraftFiles,
    onPasteIntoDraft,
    onNativePasteImages,
    onRemoveDraftImage,
    onSendMessage,
    onSteerQueuedMessage,
    onEditQueuedMessage,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
    onUpdateInteractionMode,
  };
}
