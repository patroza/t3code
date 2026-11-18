import { msg } from "gt-react-native";
import { m as resolveCopy } from "../../i18n/messages";
import type { WorktreeCleanupConfirmation } from "@t3tools/client-runtime/state/worktreeCleanup";

export interface WorktreeCleanupPromptButtons {
  readonly title: string;
  readonly message: string;
  readonly onKeep: () => void;
  readonly onRemove: () => void;
}

export function buildWorktreeCleanupPrompt(displayWorktreePath: string): {
  readonly title: string;
  readonly message: string;
} {
  return {
    title: resolveCopy(msg("Remove worktree?")),
    message: resolveCopy(
      msg(
        "This thread is the last active one linked to the worktree “{value0}”. Remove it when archiving? The branch is kept.",
        { value0: displayWorktreePath },
      ),
    ),
  };
}

/**
 * Presents the archive-time cleanup confirmation through the platform's
 * surface: the native alert on iOS, the in-app confirm dialog elsewhere.
 * Keep archives without cleanup; Remove archives and cleans up.
 */
export function presentWorktreeCleanupConfirmation(input: {
  readonly isIos: boolean;
  readonly displayWorktreePath: string;
  readonly presentAlert: (buttons: WorktreeCleanupPromptButtons) => void;
  readonly presentConfirmDialog: (buttons: WorktreeCleanupPromptButtons) => void;
}): Promise<WorktreeCleanupConfirmation<never>> {
  const { title, message } = buildWorktreeCleanupPrompt(input.displayWorktreePath);
  return new Promise((resolve) => {
    const buttons: WorktreeCleanupPromptButtons = {
      title,
      message,
      onKeep: () => {
        resolve({ kind: "declined" });
      },
      onRemove: () => {
        resolve({ kind: "confirmed" });
      },
    };
    if (input.isIos) {
      input.presentAlert(buttons);
      return;
    }
    input.presentConfirmDialog(buttons);
  });
}
