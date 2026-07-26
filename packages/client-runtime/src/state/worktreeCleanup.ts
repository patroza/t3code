/**
 * Shared archive-time worktree cleanup flow.
 *
 * The server owns the safety decision (preview + conditional cleanup RPCs);
 * this module owns the client sequencing shared by web and mobile: act only
 * when the server reports a candidate, optionally confirm based on client
 * policy, archive before cleanup, and report cleanup problems without
 * failing the archive itself.
 */
import type { WorktreeCleanupStatus } from "@t3tools/contracts";

export interface ArchiveWorktreeCleanupCandidate {
  readonly worktreePath: string;
  readonly branch: string;
}

/** Shortens a worktree path to its final segment for prompts and toasts. */
export function formatWorktreePathForDisplay(worktreePath: string): string {
  const trimmed = worktreePath.trim();
  if (!trimmed) {
    return worktreePath;
  }
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  const parts = normalized.split("/");
  const lastPart = parts[parts.length - 1]?.trim() ?? "";
  return lastPart.length > 0 ? lastPart : trimmed;
}

export type WorktreeCleanupConfirmation<TAbort> =
  | { readonly kind: "confirmed" }
  | { readonly kind: "declined" }
  /** The confirmation surface itself failed; the archive is not attempted. */
  | { readonly kind: "aborted"; readonly result: TAbort };

export type WorktreeCleanupOutcome =
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "done"; readonly status: WorktreeCleanupStatus };

export type ArchiveWithWorktreeCleanupResult<TArchive, TAbort> =
  | { readonly kind: "archived"; readonly result: TArchive }
  | { readonly kind: "aborted"; readonly result: TAbort };

export type WorktreeRemovalPolicy = "confirm" | "remove";

export async function runArchiveWithWorktreeCleanup<TArchive, TAbort = never>(input: {
  /** Server-authoritative preview; null when ineligible or when the preview failed. */
  readonly previewCandidate: () => Promise<ArchiveWorktreeCleanupCandidate | null>;
  /** Whether an eligible worktree is confirmed first or removed automatically. */
  readonly removalPolicy: WorktreeRemovalPolicy;
  /** Confirmation surface, or null when none is available. */
  readonly confirmRemoval:
    | ((prompt: {
        readonly candidate: ArchiveWorktreeCleanupCandidate;
        readonly displayWorktreePath: string;
      }) => Promise<WorktreeCleanupConfirmation<TAbort>>)
    | null;
  readonly archive: () => Promise<TArchive>;
  readonly isArchiveSuccess: (result: TArchive) => boolean;
  readonly cleanup: () => Promise<WorktreeCleanupOutcome>;
  readonly onCleanupFailed: (displayWorktreePath: string, message: string) => void;
  readonly onCleanupRetained: (displayWorktreePath: string) => void;
}): Promise<ArchiveWithWorktreeCleanupResult<TArchive, TAbort>> {
  const candidate = await input.previewCandidate();
  let shouldCleanup = false;
  let displayWorktreePath: string | null = null;
  if (candidate) {
    displayWorktreePath = formatWorktreePathForDisplay(candidate.worktreePath);
    if (input.removalPolicy === "remove") {
      shouldCleanup = true;
    } else if (input.confirmRemoval) {
      const confirmation = await input.confirmRemoval({ candidate, displayWorktreePath });
      if (confirmation.kind === "aborted") {
        return { kind: "aborted", result: confirmation.result };
      }
      shouldCleanup = confirmation.kind === "confirmed";
    }
  }

  const archiveResult = await input.archive();
  if (!shouldCleanup || displayWorktreePath === null || !input.isArchiveSuccess(archiveResult)) {
    return { kind: "archived", result: archiveResult };
  }

  const cleanupOutcome = await input.cleanup();
  if (cleanupOutcome.kind === "failed") {
    input.onCleanupFailed(displayWorktreePath, cleanupOutcome.message);
  } else if (cleanupOutcome.status === "retained-active") {
    input.onCleanupRetained(displayWorktreePath);
  }
  return { kind: "archived", result: archiveResult };
}
