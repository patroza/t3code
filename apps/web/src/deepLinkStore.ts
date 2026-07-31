/**
 * Pending deep-link target for scroll-into-view after navigation / thread load.
 * Written when consuming `?thread=` / `#message-` URLs; taken once by ChatView.
 */

export type PendingDeepLinkTarget = {
  readonly threadId: string;
  readonly messageId: string | null;
};

let pending: PendingDeepLinkTarget | null = null;

export function setPendingDeepLink(target: PendingDeepLinkTarget): void {
  const threadId = target.threadId.trim();
  if (threadId === "") {
    pending = null;
    return;
  }
  const messageId = target.messageId?.trim() || null;
  pending = {
    threadId,
    messageId: messageId === "" ? null : messageId,
  };
}

export function peekPendingDeepLink(): PendingDeepLinkTarget | null {
  return pending;
}

/** Consume a pending message scroll for this thread (thread-level target remains until navigated). */
export function takePendingDeepLinkMessage(threadId: string): string | null {
  if (pending === null) return null;
  if (pending.threadId !== threadId) return null;
  const messageId = pending.messageId;
  pending = { threadId: pending.threadId, messageId: null };
  return messageId;
}

export function clearPendingDeepLink(): void {
  pending = null;
}
