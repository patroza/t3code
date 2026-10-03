import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef } from "react";

import {
  captureDeepLinkFromWindowLocation,
  markDeepLinkNavigationIssued,
  peekPendingDeepLink,
  setPendingDeepLink,
} from "../deepLinkStore";
import { parseOmegentDeepLink } from "../deepLinks";
import { buildThreadRouteParams } from "../threadRoutes";
import { findThreadRef, useThreadRefs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

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
 * stashes intent immediately (before index auto-draft / welcome bootstrap can
 * wipe `?thread=`), then navigates to the thread route.
 *
 * Does not require the thread to already be in the shell list — falls back to
 * the primary environment id. The thread route owns missing/loading states.
 */
export function OmegentDeepLinkCoordinator() {
  const navigate = useNavigate();
  const threadRefs = useThreadRefs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const handledThreadIdRef = useRef<string | null>(null);

  // Capture before paint so sibling landing effects cannot replace the URL first.
  useLayoutEffect(() => {
    captureDeepLinkFromWindowLocation();
  }, []);

  useEffect(() => {
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

    const knownRef = findThreadRef(ThreadId.make(threadId));
    // Prefer the shell list (correct env in multi-env). Fall back to primary
    // so we never sit forever on `/` waiting for a ref that is slow/empty.
    const threadRef =
      knownRef ??
      (primaryEnvironmentId !== null
        ? scopeThreadRef(primaryEnvironmentId, ThreadId.make(threadId))
        : null);
    if (threadRef === null) {
      // No environment yet — retry when catalog/primary becomes available.
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
  }, [navigate, primaryEnvironmentId, threadRefs]);

  return null;
}
