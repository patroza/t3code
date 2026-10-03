import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { hasDesktopBridge, readDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;

/**
 * Compare every field the bridge reports: a field omitted here would leave the
 * hook holding a stale topology, since an unequal read that compares equal is
 * never published.
 */
export function bootstrapsEqual(
  left: ReadonlyArray<DesktopEnvironmentBootstrap>,
  right: ReadonlyArray<DesktopEnvironmentBootstrap>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((entry, index) => {
    const other = right[index];
    return (
      other !== undefined &&
      entry.id === other.id &&
      entry.label === other.label &&
      entry.runningDistro === other.runningDistro &&
      entry.httpBaseUrl === other.httpBaseUrl &&
      entry.wsBaseUrl === other.wsBaseUrl &&
      entry.bootstrapToken === other.bootstrapToken
    );
  });
}

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). The bridge exposes no change event, so we re-read on an interval;
 * failed reads retain the latest successful snapshot, while a successful empty
 * read clears it. Use this instead of polling the bridge ad hoc so every
 * renderer consumer reads the same topology.
 *
 * Each read allocates a fresh array, so the previous reference is kept when the
 * topology is unchanged — otherwise every tick would re-render consumers with
 * an equal-but-new value. Without a bridge no topology can ever appear, so the
 * poll is not started at all.
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  const [bootstraps, setBootstraps] = useState<ReadonlyArray<DesktopEnvironmentBootstrap>>(
    readDesktopSecondaryBootstraps,
  );

  useEffect(() => {
    if (!hasDesktopBridge()) {
      return;
    }

    const read = () => {
      const next = readDesktopSecondaryBootstraps();
      setBootstraps((previous) => (bootstrapsEqual(previous, next) ? previous : next));
    };
    read();
    const interval = setInterval(read, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
    return () => clearInterval(interval);
  }, []);

  return bootstraps;
}
