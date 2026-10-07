import { WorktreeLifecycleError } from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import { actionFailureMessage, actionFailureTitle } from "./threadActionMessages";
import {
  buildWorktreeCleanupPrompt,
  presentWorktreeCleanupConfirmation,
} from "./worktreeCleanupPrompt";

describe("presentWorktreeCleanupConfirmation", () => {
  it("uses the native alert on iOS and never the confirm dialog", async () => {
    const presentAlert = vi.fn(
      (buttons: { readonly onKeep: () => void; readonly onRemove: () => void }) => {
        buttons.onRemove();
      },
    );
    const presentConfirmDialog = vi.fn();

    const confirmation = await presentWorktreeCleanupConfirmation({
      isIos: true,
      displayWorktreePath: "feature-1",
      presentAlert,
      presentConfirmDialog,
    });

    expect(confirmation).toEqual({ kind: "confirmed" });
    expect(presentAlert).toHaveBeenCalledTimes(1);
    expect(presentConfirmDialog).not.toHaveBeenCalled();
  });

  it("uses the confirm dialog host elsewhere", async () => {
    const presentAlert = vi.fn();
    const presentConfirmDialog = vi.fn(
      (buttons: { readonly onKeep: () => void; readonly onRemove: () => void }) => {
        buttons.onKeep();
      },
    );

    const confirmation = await presentWorktreeCleanupConfirmation({
      isIos: false,
      displayWorktreePath: "feature-1",
      presentAlert,
      presentConfirmDialog,
    });

    expect(confirmation).toEqual({ kind: "declined" });
    expect(presentAlert).not.toHaveBeenCalled();
    expect(presentConfirmDialog).toHaveBeenCalledTimes(1);
  });

  it("resolves declined for Keep and confirmed for Remove", async () => {
    const keep = presentWorktreeCleanupConfirmation({
      isIos: true,
      displayWorktreePath: "feature-1",
      presentAlert: (buttons) => {
        buttons.onKeep();
      },
      presentConfirmDialog: () => {},
    });
    await expect(keep).resolves.toEqual({ kind: "declined" });

    const remove = presentWorktreeCleanupConfirmation({
      isIos: false,
      displayWorktreePath: "feature-1",
      presentAlert: () => {},
      presentConfirmDialog: (buttons) => {
        buttons.onRemove();
      },
    });
    await expect(remove).resolves.toEqual({ kind: "confirmed" });
  });

  it("names the worktree in the prompt copy", () => {
    const prompt = buildWorktreeCleanupPrompt("feature-1");
    expect(prompt.title).toBe("Remove worktree?");
    expect(prompt.message).toContain("feature-1");
    expect(prompt.message).toContain("branch is kept");
  });
});

describe("thread action failure messages", () => {
  it("surfaces unarchive restoration errors with the server-provided detail", () => {
    const restorationError = new WorktreeLifecycleError({
      operation: "restore",
      threadId: ThreadId.make("thread-1"),
      detail:
        "Failed to recreate the worktree at /wt/feature-1 from branch 'feature-1': branch missing. The thread stays archived.",
    });
    expect(actionFailureTitle("unarchive")).toBe("Could not unarchive thread");
    expect(actionFailureMessage("unarchive", Cause.fail(restorationError))).toContain(
      "Failed to recreate the worktree",
    );
  });

  it("falls back to a generic message when the cause has no message", () => {
    expect(actionFailureMessage("unarchive", Cause.fail(new Error("")))).toBe(
      "The thread could not be unarchived.",
    );
  });
});
