/**
 * Pending deep-link target for open + scroll-into-view after navigation / thread load.
 * Written when consuming `?thread=` / `#message-` URLs; taken once by ChatView.
 *
 * Capture early (before bootstrap) so the index "new draft" landing cannot wipe
 * `?thread=` before OmegentDeepLinkCoordinator navigates.
 */

export type PendingDeepLinkTarget = {
  readonly threadId: string;
  readonly messageId: string | null;
  /** Still waiting to navigate to the thread route (blocks index auto-draft). */
  readonly awaitingNavigation: boolean;
};

let pending: PendingDeepLinkTarget | null = null;

export function setPendingDeepLink(target: {
  readonly threadId: string;
  readonly messageId: string | null;
  readonly awaitingNavigation?: boolean;
}): void {
  const threadId = target.threadId.trim();
  if (threadId === "") {
    pending = null;
    return;
  }
  const messageId = target.messageId?.trim() || null;
  pending = {
    threadId,
    messageId: messageId === "" ? null : messageId,
    awaitingNavigation: target.awaitingNavigation ?? true,
  };
}

export function peekPendingDeepLink(): PendingDeepLinkTarget | null {
  return pending;
}

/** True while a `?thread=` open is in flight (index must not auto-start a draft). */
export function hasAwaitingThreadDeepLink(): boolean {
  return pending?.awaitingNavigation === true;
}

/** Mark that the thread route navigation has been issued (index may resume if still on `/`). */
export function markDeepLinkNavigationIssued(threadId: string): void {
  if (pending === null || pending.threadId !== threadId) return;
  pending = { ...pending, awaitingNavigation: false };
}

/** Consume a pending message scroll for this thread (thread-level target remains until cleared). */
export function takePendingDeepLinkMessage(threadId: string): string | null {
  if (pending === null) return null;
  if (pending.threadId !== threadId) return null;
  const messageId = pending.messageId;
  pending = { threadId: pending.threadId, messageId: null, awaitingNavigation: false };
  return messageId;
}

export function clearPendingDeepLink(): void {
  pending = null;
}
