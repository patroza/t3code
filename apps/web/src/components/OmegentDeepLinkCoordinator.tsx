import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";

import {
  clearPendingDeepLink,
  markDeepLinkNavigationIssued,
  peekPendingDeepLink,
  setPendingDeepLink,
} from "../deepLinkStore";
import { parseOmegentDeepLink } from "../deepLinks";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  findThreadRef,
  useAllEnvironmentShellsBootstrapped,
  useThreadRefs,
} from "../state/entities";

function stripThreadQueryFromLocation(): void {
  const next = new URL(window.location.href);
  if (!next.searchParams.has("thread")) return;
  next.searchParams.delete("thread");
  const search = next.searchParams.toString();
  const path = `${next.pathname}${search === "" ? "" : `?${search}`}${next.hash}`;
  window.history.replaceState(window.history.state, "", path);
}

/**
 * Consumes `/?thread={id}#message-{messageId}` deep links:
 * stashes intent immediately (before the index auto-draft can wipe `?thread=`),
 * then navigates to the thread route once shells are bootstrapped.
 */
export function OmegentDeepLinkCoordinator() {
  const navigate = useNavigate();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const threadRefs = useThreadRefs();
  const handledThreadIdRef = useRef<string | null>(null);

  // Capture before paint so sibling index-route effects that also wait on
  // bootstrap cannot replace the URL with a new draft first.
  useLayoutEffect(() => {
    const { threadId, messageId } = parseOmegentDeepLink(new URL(window.location.href));
    if (threadId === null) return;
    const existing = peekPendingDeepLink();
    if (existing !== null && existing.threadId === threadId) {
      // Prefer a message id from the live URL when present.
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
  }, []);

  useEffect(() => {
    if (!bootstrapped) return;

    const fromUrl = parseOmegentDeepLink(new URL(window.location.href));
    const pending = peekPendingDeepLink();
    const threadId = fromUrl.threadId ?? pending?.threadId ?? null;
    const messageId = fromUrl.messageId ?? pending?.messageId ?? null;
    if (threadId === null) return;
    if (handledThreadIdRef.current === threadId) return;

    // Keep store in sync when we only had URL intent (or vice versa).
    setPendingDeepLink({
      threadId,
      messageId,
      awaitingNavigation: pending?.awaitingNavigation ?? true,
    });

    const threadRef = findThreadRef(ThreadId.make(threadId));
    if (threadRef === null) {
      // Shells are bootstrapped: this id is not in the open shell list.
      // Drop the deep link so the index route can fall through to a new draft.
      handledThreadIdRef.current = threadId;
      clearPendingDeepLink();
      stripThreadQueryFromLocation();
      return;
    }

    handledThreadIdRef.current = threadId;
    markDeepLinkNavigationIssued(threadId);

    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
      ...(messageId !== null ? { hash: `message-${messageId}` } : {}),
    }).then(() => {
      stripThreadQueryFromLocation();
    });
  }, [bootstrapped, navigate, threadRefs]);

  return null;
}
