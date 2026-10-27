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
import { useThreadRefs } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

function stripThreadQueryFromLocation(): void {
  const next = new URL(window.location.href);
  if (!next.searchParams.has("thread")) return;
  next.searchParams.delete("thread");
  const search = next.searchParams.toString();
  const path = `${next.pathname}${search === "" ? "" : `?${search}`}${next.hash}`;
  window.history.replaceState(window.history.state, "", path);
}

/** Capture deep links before landing navigation clears them; missing threads use the primary environment. */
export function OmegentDeepLinkCoordinator() {
  const navigate = useNavigate();
  const threadRefs = useThreadRefs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const handledThreadIdRef = useRef<string | null>(null);

  // oxlint-disable-next-line t3code/react-effect-budget -- Capture browser URL intent before sibling landing effects replace it.
  useLayoutEffect(() => {
    captureDeepLinkFromWindowLocation();
  }, []);

  // oxlint-disable-next-line t3code/react-effect-budget -- Route external URL intent when the environment catalog becomes available.
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

    const knownRef = threadRefs.find((ref) => ref.threadId === threadId) ?? null;
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
