import { useAtomValue } from "@effect/atom-react";
import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

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

/** Poll the bridge while subscribed; preserve equal snapshots and retain the last success on failure. */
const desktopLocalBootstrapsAtom = Atom.make((get) => {
  if (!hasDesktopBridge()) return [];
  const interval = setInterval(
    () => get.setSelf(readDesktopSecondaryBootstraps()),
    DESKTOP_LOCAL_BOOTSTRAP_POLL_MS,
  );
  get.addFinalizer(() => clearInterval(interval));
  return readDesktopSecondaryBootstraps();
}).pipe(Atom.withLabel("desktop-local-bootstraps"));

export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useAtomValue(desktopLocalBootstrapsAtom);
}
