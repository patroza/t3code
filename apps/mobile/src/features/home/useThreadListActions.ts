import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { canSettle } from "@t3tools/client-runtime/state/thread-settled";
import { runArchiveWithWorktreeCleanup } from "@t3tools/client-runtime/state/worktreeCleanup";
import * as Cause from "effect/Cause";
import * as Haptics from "expo-haptics";
import { useCallback, useRef } from "react";
import { Alert } from "react-native";

import { showConfirmDialog } from "../../components/ConfirmDialogHost";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { refreshArchivedThreadsForEnvironment } from "../archive/useArchivedThreadSnapshots";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { vcsEnvironment } from "../../state/vcs";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  actionFailureMessage,
  actionFailureTitle,
  type ThreadListAction,
} from "./threadActionMessages";
import { presentWorktreeCleanupConfirmation } from "./worktreeCleanupPrompt";

/** Version skew: never send settle/unsettle to a server that predates them
    (capability defaults false on decode for older servers). */
function environmentSupportsSettlement(environmentId: EnvironmentThreadShell["environmentId"]) {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

function selectionHaptic(): void {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
}

/** Resolves to true iff the action was dispatched and succeeded. */
function useThreadActionExecutor(
  onCompleted?: (action: ThreadListAction, thread: EnvironmentThreadShell) => void,
) {
  const archiveMutation = useAtomCommand(threadEnvironment.archive, { reportFailure: false });
  const unarchiveMutation = useAtomCommand(threadEnvironment.unarchive, { reportFailure: false });
  const deleteMutation = useAtomCommand(threadEnvironment.delete, { reportFailure: false });
  const settleMutation = useAtomCommand(threadEnvironment.settle, { reportFailure: false });
  const unsettleMutation = useAtomCommand(threadEnvironment.unsettle, { reportFailure: false });
  const inFlightThreadKeys = useRef(new Set<string>());

  const executeAction = useCallback(
    async (action: ThreadListAction, thread: EnvironmentThreadShell) => {
      const key = scopedThreadKey(thread.environmentId, thread.id);
      if (inFlightThreadKeys.current.has(key)) {
        return false;
      }

      inFlightThreadKeys.current.add(key);
      selectionHaptic();
      try {
        if (
          (action === "settle" || action === "unsettle") &&
          !environmentSupportsSettlement(thread.environmentId)
        ) {
          Alert.alert(
            actionFailureTitle(action),
            "This environment's server does not support settling yet. Update the server to use Settle.",
          );
          return false;
        }
        // Settle may only target what effectiveSettled could classify as
        // settled: not starting/running sessions, not threads waiting on
        // approvals or user input. Anything else would hide live work.
        if (action === "settle" && !canSettle(thread, { now: new Date().toISOString() })) {
          Alert.alert(
            actionFailureTitle(action),
            "This thread still needs attention. Resolve or interrupt it first, then try again.",
          );
          return false;
        }
        // Archive keeps its original, narrower guard: never interrupt a
        // thread mid-turn.
        if (
          action === "archive" &&
          thread.session?.status === "running" &&
          thread.session.activeTurnId != null
        ) {
          Alert.alert(
            actionFailureTitle(action),
            "This thread is working. Interrupt it first, then try again.",
          );
          return false;
        }
        const result =
          action === "unsettle"
            ? // reason "user" pins the thread active: auto-settle stays
              // suppressed until real activity clears the pin server-side.
              await unsettleMutation({
                environmentId: thread.environmentId,
                input: { threadId: thread.id, reason: "user" },
              })
            : await (
                action === "settle"
                  ? settleMutation
                  : action === "archive"
                    ? archiveMutation
                    : action === "unarchive"
                      ? unarchiveMutation
                      : deleteMutation
              )({
                environmentId: thread.environmentId,
                input: { threadId: thread.id },
              });
        if (result._tag === "Failure") {
          Alert.alert(actionFailureTitle(action), actionFailureMessage(action, result.cause));
          return false;
        }
        // Settled threads stay in the live shell stream; only the archive
        // lifecycle still feeds the archived-snapshot surface.
        if (action === "archive" || action === "unarchive" || action === "delete") {
          refreshArchivedThreadsForEnvironment(thread.environmentId);
        }
        onCompleted?.(action, thread);
        return true;
      } finally {
        inFlightThreadKeys.current.delete(key);
      }
    },
    [
      archiveMutation,
      deleteMutation,
      onCompleted,
      settleMutation,
      unarchiveMutation,
      unsettleMutation,
    ],
  );

  return executeAction;
}

function useConfirmDeleteThread(
  executeAction: (action: ThreadListAction, thread: EnvironmentThreadShell) => Promise<boolean>,
) {
  return useCallback(
    (thread: EnvironmentThreadShell) => {
      const title = "Delete thread?";
      const message = `“${thread.title}” will be permanently deleted, including its terminal history.`;
      if (process.env.EXPO_OS === "ios") {
        Alert.alert(title, message, [
          { text: "Cancel", style: "cancel" },
          {
            text: "Delete",
            style: "destructive",
            onPress: () => {
              void executeAction("delete", thread);
            },
          },
        ]);
        return;
      }
      showConfirmDialog({
        title,
        message,
        confirmText: "Delete",
        destructive: true,
        onConfirm: () => {
          void executeAction("delete", thread);
        },
      });
    },
    [executeAction],
  );
}

export function useThreadListActions(): {
  readonly archiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly settleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly unsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
} {
  const executeAction = useThreadActionExecutor();
  const previewWorktreeCleanup = useAtomCommand(vcsEnvironment.previewWorktreeCleanup, {
    reportFailure: false,
  });
  const cleanupThreadWorktree = useAtomCommand(vcsEnvironment.cleanupThreadWorktree, {
    reportFailure: false,
  });

  const archiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void runArchiveWithWorktreeCleanup({
        // Server-authoritative preview; a failure (old server, transient
        // error) degrades to a plain archive without a prompt. A thread
        // mid-turn keeps the original archive guard: executeAction re-checks
        // and surfaces the alert, so it must not be prompted for cleanup.
        previewCandidate: async () => {
          if (thread.session?.status === "running" && thread.session.activeTurnId != null) {
            return null;
          }
          const preview = await previewWorktreeCleanup({
            environmentId: thread.environmentId,
            input: { threadId: thread.id },
          });
          return preview._tag === "Success" ? preview.value.candidate : null;
        },
        confirmRemoval: ({ displayWorktreePath }) =>
          presentWorktreeCleanupConfirmation({
            isIos: process.env.EXPO_OS === "ios",
            displayWorktreePath,
            presentAlert: (buttons) => {
              Alert.alert(buttons.title, buttons.message, [
                { text: "Keep", style: "cancel", onPress: buttons.onKeep },
                { text: "Remove", style: "destructive", onPress: buttons.onRemove },
              ]);
            },
            presentConfirmDialog: (buttons) => {
              showConfirmDialog({
                title: buttons.title,
                message: buttons.message,
                cancelText: "Keep",
                confirmText: "Remove",
                destructive: true,
                onConfirm: buttons.onRemove,
                onCancel: buttons.onKeep,
              });
            },
          }),
        archive: () => executeAction("archive", thread),
        isArchiveSuccess: (archived) => archived,
        cleanup: async () => {
          const result = await cleanupThreadWorktree({
            environmentId: thread.environmentId,
            input: { threadId: thread.id },
          });
          if (result._tag === "Failure") {
            const error = Cause.squash(result.cause);
            return {
              kind: "failed",
              message:
                error instanceof Error && error.message.trim().length > 0
                  ? error.message
                  : "The worktree could not be removed.",
            } as const;
          }
          return { kind: "done", status: result.value.status } as const;
        },
        // Cleanup problems are nonfatal: the archive itself already
        // succeeded.
        onCleanupFailed: (displayWorktreePath, message) => {
          Alert.alert(
            "Thread archived, but worktree removal failed",
            `Could not remove ${displayWorktreePath}. ${message}`,
          );
        },
        onCleanupRetained: (displayWorktreePath) => {
          Alert.alert(
            "Worktree kept",
            `${displayWorktreePath} is still used by another active thread.`,
          );
        },
      });
    },
    [cleanupThreadWorktree, executeAction, previewWorktreeCleanup],
  );
  const settleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("settle", thread)) === true,
    [executeAction],
  );
  const unsettleThread = useCallback(
    async (thread: EnvironmentThreadShell) => (await executeAction("unsettle", thread)) === true,
    [executeAction],
  );

  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { archiveThread, confirmDeleteThread, settleThread, unsettleThread };
}

export function useArchivedThreadListActions(
  onCompleted: (thread: EnvironmentThreadShell) => void,
): {
  readonly unarchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly confirmDeleteThread: (thread: EnvironmentThreadShell) => void;
} {
  const handleCompleted = useCallback(
    (_action: ThreadListAction, thread: EnvironmentThreadShell) => {
      onCompleted(thread);
    },
    [onCompleted],
  );
  const executeAction = useThreadActionExecutor(handleCompleted);
  const unarchiveThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void executeAction("unarchive", thread);
    },
    [executeAction],
  );
  const confirmDeleteThread = useConfirmDeleteThread(executeAction);

  return { unarchiveThread, confirmDeleteThread };
}
