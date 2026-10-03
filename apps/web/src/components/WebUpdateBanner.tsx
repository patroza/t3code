import { useAtomValue } from "@effect/atom-react";
import { useRef } from "react";

import { primaryServerWebVersionAtom } from "../state/server";

/**
 * Whether a newer web bundle is being served than the one this tab booted with.
 * `boot` is the version observed first (what the running code was loaded from);
 * `latest` is the most recent version the server has reported. Pure so the
 * decision can be unit-tested without a DOM.
 */
export function isWebUpdateAvailable(boot: string | null, latest: string | null): boolean {
  return boot !== null && latest !== null && boot !== latest;
}

/**
 * Unobtrusive "a new version is available" affordance. The server broadcasts its
 * served web-bundle version over the lifecycle stream; the first value this tab
 * sees is the version it booted with, so any later, different value means the
 * assets were hot-swapped on the server. We never reload automatically -- the
 * user reloads when convenient. (vitePreloadRecovery still auto-reloads on a
 * genuinely missing chunk, so nothing breaks if the user ignores this.)
 */
export function WebUpdateBanner() {
  const latest = useAtomValue(primaryServerWebVersionAtom);
  const bootVersionRef = useRef<string | null>(null);
  if (latest !== null && bootVersionRef.current === null) {
    bootVersionRef.current = latest;
  }

  if (!isWebUpdateAvailable(bootVersionRef.current, latest)) {
    return null;
  }

  return (
    <div
      data-testid="web-update-banner"
      className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-full border border-border bg-background/95 px-4 py-2 text-sm shadow-lg backdrop-blur"
      role="status"
    >
      <span className="text-muted-foreground">A new version of T3 Code is available.</span>
      <button
        type="button"
        className="rounded-full bg-primary px-3 py-1 font-medium text-primary-foreground hover:opacity-90"
        onClick={() => {
          window.location.reload();
        }}
      >
        Reload
      </button>
    </div>
  );
}
