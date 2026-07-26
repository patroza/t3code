import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationThreadActivity,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ThreadId,
} from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import {
  useOlderThreadActivities,
  type OlderActivitiesCursor,
} from "@t3tools/client-runtime/state/older-thread-activities";
import { deriveActiveWorkStartedAt } from "@t3tools/shared/orchestrationTiming";

import { makeQueuedMessageMetadata } from "../lib/commandMetadata";
import {
  convertPastedImagesToAttachments,
  pasteComposerClipboard,
  pickComposerImages,
} from "../lib/composerImages";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { buildThreadFeed } from "../lib/threadActivity";
import { appAtomRegistry } from "../state/atom-registry";
import {
  appendComposerDraftAttachments,
  appendComposerDraftText,
  clearComposerDraftContent,
  composerDraftsAtom,
  ensureComposerDraftsLoaded,
  getComposerDraftSnapshot,
  removeComposerDraftAttachment,
  setComposerDraftText,
  updateComposerDraftSettings,
  useComposerDraft,
} from "./use-composer-drafts";
import {
  setPendingConnectionError,
  useRemoteConnectionStatus,
} from "../state/use-remote-environment-registry";
import { orchestrationEnvironment } from "../state/orchestration";
import { useSelectedThreadDetail } from "../state/use-thread-detail";
import { useThreadSelection } from "../state/use-thread-selection";
import { useAtomCommand } from "./use-atom-command";
import { threadEnvironment } from "./threads";
import {
  enqueueThreadOutboxMessage,
  removeThreadOutboxMessage,
  updateThreadOutboxMessage,
} from "./thread-outbox";
import { useThreadOutboxMessages } from "./use-thread-outbox";

const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];

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
    appendComposerDraftAttachments(threadKey, input.attachments);
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
  const { selectedThread: selectedThreadShell } = useThreadSelection();
  const selectedThreadDetail = useSelectedThreadDetail();
  const composerDrafts = useAtomValue(composerDraftsAtom);
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const { connectedEnvironments } = useRemoteConnectionStatus();

  useEffect(() => {
    ensureComposerDraftsLoaded();
  }, []);

  const selectedThreadKey = selectedThreadShell
    ? scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id)
    : null;
  const selectedThreadQueuedMessages = useMemo(
    () => (selectedThreadKey ? (queuedMessagesByThreadKey[selectedThreadKey] ?? []) : []),
    [queuedMessagesByThreadKey, selectedThreadKey],
  );

  // ── Older-history lazy-load (shared engine; see useOlderThreadActivities) ──
  // The detail snapshot windows activities to the most recent page (the server
  // sets `hasMoreActivities`); older pages are fetched on demand and prepended.
  const loadThreadActivities = useAtomCommand(orchestrationEnvironment.loadThreadActivities, {
    reportFailure: false,
  });
  const steerQueuedMessage = useAtomCommand(threadEnvironment.steerQueuedMessage, {
    label: "steer queued message",
  });
  const removeServerQueuedMessage = useAtomCommand(threadEnvironment.removeQueuedMessage, {
    label: "remove queued message",
  });
  const updateServerQueuedMessage = useAtomCommand(threadEnvironment.updateQueuedMessage, {
    label: "update queued message",
  });
  const [editingQueuedMessage, setEditingQueuedMessage] = useState<{
    readonly messageId: MessageId;
    readonly source: "local" | "server";
    readonly previousDraftText: string;
  } | null>(null);
  const selectedEnvironmentIdForActivities = selectedThreadShell?.environmentId ?? null;
  const selectedThreadIdForActivities = selectedThreadShell?.id ?? null;
  const loadOlderActivitiesPage = useCallback(
    async (cursor: OlderActivitiesCursor) => {
      if (selectedEnvironmentIdForActivities === null || selectedThreadIdForActivities === null) {
        return null;
      }
      const result = await loadThreadActivities({
        environmentId: selectedEnvironmentIdForActivities,
        input: { threadId: selectedThreadIdForActivities, ...cursor },
      });
      if (result._tag !== "Success") {
        // Surface real failures (a spinner that quietly gives up reads as
        // missing history); keep `hasMore` so scrolling back retries.
        if (!isAtomCommandInterrupted(result)) {
          setPendingConnectionError("Could not load older thread history.");
        }
        return null;
      }
      return result.value;
    },
    [selectedEnvironmentIdForActivities, selectedThreadIdForActivities, loadThreadActivities],
  );
  const {
    mergedActivities,
    hasMoreOlder: hasMoreOlderActivities,
    loadingOlder: loadingOlderActivities,
    loadOlder: onLoadOlderActivities,
  } = useOlderThreadActivities({
    threadKey: selectedThreadShell
      ? `${selectedThreadShell.environmentId}\u0000${selectedThreadShell.id}`
      : null,
    liveActivities: selectedThreadDetail?.activities ?? EMPTY_ACTIVITIES,
    hasMoreLiveActivities: selectedThreadDetail?.hasMoreActivities ?? false,
    loadPage: loadOlderActivitiesPage,
  });

  const selectedThreadFeed = useMemo(() => {
    // Local outbox rows must still paint while detail is hydrating — otherwise
    // send during "Loading messages…" produces no bubble until the snapshot lands.
    const feed = selectedThreadDetail
      ? buildThreadFeed({ ...selectedThreadDetail, activities: mergedActivities })
      : [];
    const timelineMessageIds = new Set(
      selectedThreadDetail?.messages.map((message) => message.id) ?? [],
    );
    const optimisticByMessageId = new Map<
      MessageId,
      (typeof feed)[number] & { readonly type: "message" }
    >();

    for (const message of selectedThreadDetail?.queuedMessages ?? []) {
      if (timelineMessageIds.has(message.messageId)) {
        continue;
      }
      optimisticByMessageId.set(message.messageId, {
        type: "message",
        id: message.messageId,
        createdAt: message.queuedAt,
        deliveryState: "queued",
        queueSource: "server",
        message: {
          id: message.messageId,
          role: "user",
          text: message.text,
          attachments: message.attachments,
          turnId: null,
          streaming: false,
          createdAt: message.queuedAt,
          updatedAt: message.queuedAt,
        },
      });
    }

    // A local outbox entry wins over the matching server projection until the
    // command acknowledgement removes it. That makes the bubble transition
    // from "Sending" to "Queued" without rendering twice.
    for (const message of selectedThreadQueuedMessages) {
      if (timelineMessageIds.has(message.messageId)) {
        continue;
      }
      optimisticByMessageId.set(message.messageId, {
        type: "message",
        id: message.messageId,
        createdAt: message.createdAt,
        queueSource: "local",
        deliveryState: connectedEnvironments.some(
          (environment) =>
            environment.environmentId === message.environmentId &&
            environment.connectionState === "connected",
        )
          ? "sending"
          : "waiting",
        previewAttachments: message.attachments,
        message: {
          id: message.messageId,
          role: "user",
          text: message.text,
          attachments: [],
          turnId: null,
          streaming: false,
          createdAt: message.createdAt,
          updatedAt: message.createdAt,
        },
      });
    }

    if (optimisticByMessageId.size === 0) {
      return feed;
    }

    return [
      ...feed,
      ...Array.from(optimisticByMessageId.values()).sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
    ];
  }, [connectedEnvironments, selectedThreadDetail, selectedThreadQueuedMessages, mergedActivities]);

  const selectedDraft = selectedThreadKey ? composerDrafts[selectedThreadKey] : null;
  const draftMessage = selectedDraft?.text ?? "";
  const draftAttachments = selectedDraft?.attachments ?? [];
  const selectedThread = selectedThreadDetail ?? selectedThreadShell;
  const modelSelection = selectedDraft?.modelSelection ?? selectedThread?.modelSelection ?? null;
  const runtimeMode = selectedDraft?.runtimeMode ?? selectedThread?.runtimeMode ?? null;
  const interactionMode = selectedDraft?.interactionMode ?? selectedThread?.interactionMode ?? null;

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

  const activeThreadBusy =
    !!selectedThread &&
    (selectedThread.session?.status === "running" || selectedThread.session?.status === "starting");

  const onSendMessage = useCallback(async () => {
    if (!selectedThreadShell) {
      return null;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const draft = getComposerDraftSnapshot(threadKey);
    const thread = selectedThreadDetail ?? selectedThreadShell;
    const text = draft.text.trim();
    const attachments = draft.attachments;
    if (editingQueuedMessage !== null) {
      if (editingQueuedMessage.source === "local") {
        const message = selectedThreadQueuedMessages.find(
          (candidate) => candidate.messageId === editingQueuedMessage.messageId,
        );
        if (message) {
          if (text.length === 0) {
            await removeThreadOutboxMessage(message);
          } else {
            const updated = await updateThreadOutboxMessage({ ...message, text });
            if (!updated) return null;
          }
        }
      } else if (text.length === 0) {
        const result = await removeServerQueuedMessage({
          environmentId: selectedThreadShell.environmentId,
          input: { threadId: selectedThreadShell.id, messageId: editingQueuedMessage.messageId },
        });
        if (result._tag !== "Success") return null;
      } else {
        const result = await updateServerQueuedMessage({
          environmentId: selectedThreadShell.environmentId,
          input: {
            threadId: selectedThreadShell.id,
            messageId: editingQueuedMessage.messageId,
            text,
          },
        });
        if (result._tag !== "Success") return null;
      }
      setComposerDraftText(threadKey, editingQueuedMessage.previousDraftText);
      setEditingQueuedMessage(null);
      return editingQueuedMessage.messageId;
    }
    if (text.length === 0 && attachments.length === 0) {
      return null;
    }

    const metadata = makeQueuedMessageMetadata();
    const messageId = MessageId.make(metadata.messageId);
    // Enqueue updates the in-memory outbox synchronously so the feed can paint
    // "Sending" before disk I/O finishes. Clear the draft in the same turn and
    // return immediately — durability trails off the critical path.
    void enqueueThreadOutboxMessage({
      environmentId: selectedThreadShell.environmentId,
      threadId: selectedThreadShell.id,
      messageId,
      commandId: CommandId.make(metadata.commandId),
      text,
      attachments,
      modelSelection: draft.modelSelection ?? thread.modelSelection,
      runtimeMode: draft.runtimeMode ?? thread.runtimeMode,
      interactionMode: draft.interactionMode ?? thread.interactionMode,
      createdAt: metadata.createdAt,
    }).catch((error) => {
      // Memory outbox already rolled back on write failure; restore the draft.
      setComposerDraftText(threadKey, draft.text);
      if (draft.attachments.length > 0) {
        appendComposerDraftAttachments(threadKey, draft.attachments);
      }
      setPendingConnectionError(
        error instanceof Error ? error.message : "Failed to save the queued message.",
      );
    });
    clearComposerDraftContent(threadKey);
    return messageId;
  }, [
    editingQueuedMessage,
    removeServerQueuedMessage,
    selectedThreadDetail,
    selectedThreadQueuedMessages,
    selectedThreadShell,
    updateServerQueuedMessage,
  ]);

  const onSteerQueuedMessage = useCallback(
    async (messageId: MessageId) => {
      if (!selectedThreadShell) {
        return;
      }
      await steerQueuedMessage({
        environmentId: selectedThreadShell.environmentId,
        input: { threadId: selectedThreadShell.id, messageId },
      });
    },
    [selectedThreadShell, steerQueuedMessage],
  );

  const onEditQueuedMessage = useCallback(
    async (messageId: MessageId, source: "local" | "server") => {
      if (!selectedThreadShell) {
        return;
      }
      const message =
        source === "local"
          ? selectedThreadQueuedMessages.find((candidate) => candidate.messageId === messageId)
          : selectedThreadDetail?.queuedMessages.find(
              (candidate) => candidate.messageId === messageId,
            );
      if (!message) return;
      const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
      const previousDraftText =
        editingQueuedMessage?.previousDraftText ?? getComposerDraftSnapshot(threadKey).text;
      setEditingQueuedMessage({
        messageId,
        source,
        previousDraftText,
      });
      setComposerDraftText(threadKey, message.text);
    },
    [editingQueuedMessage, selectedThreadDetail, selectedThreadQueuedMessages, selectedThreadShell],
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

  const onPickDraftImages = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pickComposerImages({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
    }
  }, [composerDrafts, selectedThreadShell]);

  const onPasteIntoDraft = useCallback(async () => {
    if (!selectedThreadShell) {
      return;
    }

    const threadKey = scopedThreadKey(selectedThreadShell.environmentId, selectedThreadShell.id);
    const result = await pasteComposerClipboard({
      existingCount: composerDrafts[threadKey]?.attachments.length ?? 0,
    });
    if (result.images.length > 0) {
      appendComposerDraftAttachments(threadKey, result.images);
    }
    if (result.text) {
      appendComposerDraftText(threadKey, result.text);
    }
    if (result.error) {
      setPendingConnectionError(result.error);
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
      updateComposerDraftSettings(selectedThreadKey, { modelSelection: value });
    },
    [selectedThreadKey],
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
      updateComposerDraftSettings(selectedThreadKey, { interactionMode: value });
    },
    [selectedThreadKey],
  );

  return {
    selectedThreadFeed,
    activeWorkStartedAt,
    draftMessage,
    draftAttachments,
    modelSelection,
    runtimeMode,
    interactionMode,
    activeThreadBusy,
    isEditingQueuedMessage: editingQueuedMessage !== null,
    // Lazy-loaded older pages + the live window — the full loaded activity set.
    // Request derivations must run over this (not the windowed live set alone)
    // so prompts pulled in by scroll-up still surface, matching web.
    mergedActivities,
    hasMoreOlderActivities,
    loadingOlderActivities,
    onLoadOlderActivities,
    onChangeDraftMessage,
    onPickDraftImages,
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
