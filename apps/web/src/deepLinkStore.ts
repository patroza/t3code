/**
 * Pending deep-link target for open + scroll-into-view after navigation / thread load.
 * Written when consuming `?thread=` / `#message-` URLs; taken once by ChatView.
 *
 * Capture as early as possible (module load + layout) so index auto-draft /
 * welcome bootstrap cannot wipe `?thread=` before navigation.
 */

import { parseOmegentDeepLink } from "./deepLinks";

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

/**
 * True when a thread deep link still owns landing: live `?thread=` query and/or
 * pending store still awaiting navigation.
 */
export function hasThreadDeepLinkIntent(): boolean {
  if (hasAwaitingThreadDeepLink()) {
    return true;
  }
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return parseOmegentDeepLink(new URL(window.location.href)).threadId !== null;
  } catch {
    return false;
  }
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

/** Best-effort capture from the current URL (safe to call more than once). */
export function captureDeepLinkFromWindowLocation(): void {
  if (typeof window === "undefined") {
    return;
  }
  try {
    const { threadId, messageId } = parseOmegentDeepLink(new URL(window.location.href));
    if (threadId === null) {
      return;
    }
    const existing = pending;
    if (existing !== null && existing.threadId === threadId) {
      if (messageId !== null && existing.messageId === null) {
        setPendingDeepLink({
          threadId,
          messageId,
          awaitingNavigation: existing.awaitingNavigation,
        });
      }
      return;
    }
    setPendingDeepLink({ threadId, messageId, awaitingNavigation: true });
  } catch {
    // ignore invalid location
  }
}

// Capture before React mounts so other landing effects cannot race the URL alone.
captureDeepLinkFromWindowLocation();
