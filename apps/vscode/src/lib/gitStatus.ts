import type { VcsStatusResult, VcsStatusStreamEvent } from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";

/** A snapshot emitted while the remote poller is still cold carries `remote: null`; keep the
 * previously known remote (and its change request) instead of blanking the PR indicator. */
export function applyVcsStatusStreamEvent(
  current: VcsStatusResult | null,
  event: VcsStatusStreamEvent,
): VcsStatusResult {
  if (event._tag === "snapshot" && event.remote === null && current !== null) {
    return applyGitStatusStreamEvent(current, { _tag: "localUpdated", local: event.local });
  }
  return applyGitStatusStreamEvent(current, event);
}
