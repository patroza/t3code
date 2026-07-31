import { ThreadId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { setPendingDeepLink } from "../deepLinkStore";
import { parseOmegentDeepLink } from "../deepLinks";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  findThreadRef,
  useAllEnvironmentShellsBootstrapped,
  useThreadRefs,
} from "../state/entities";

/**
 * Consumes `/?thread={id}#message-{messageId}` deep links:
 * navigates to the thread route once shells are bootstrapped and stashes a
 * pending message target for ChatView scroll-into-view.
 */
export function OmegentDeepLinkCoordinator() {
  const navigate = useNavigate();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const threadRefs = useThreadRefs();
  const handledThreadIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!bootstrapped) return;

    const url = new URL(window.location.href);
    const { threadId, messageId } = parseOmegentDeepLink(url);
    if (threadId === null) return;
    if (handledThreadIdRef.current === threadId) return;

    const threadRef = findThreadRef(ThreadId.make(threadId));
    if (threadRef === null) {
      // Shell list may still be catching up after bootstrap.
      return;
    }

    handledThreadIdRef.current = threadId;
    setPendingDeepLink({ threadId, messageId });

    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
      replace: true,
      hash: messageId !== null ? `message-${messageId}` : undefined,
    }).then(() => {
      // Drop the query form so the address bar matches the canonical route.
      const next = new URL(window.location.href);
      if (next.searchParams.has("thread")) {
        next.searchParams.delete("thread");
        const search = next.searchParams.toString();
        const path = `${next.pathname}${search === "" ? "" : `?${search}`}${next.hash}`;
        window.history.replaceState(window.history.state, "", path);
      }
    });
  }, [bootstrapped, navigate, threadRefs]);

  return null;
}
