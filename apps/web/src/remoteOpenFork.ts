import type { RemoteOpenTarget } from "@t3tools/contracts";

// A paired server that advertises the same SSH route as the desktop's own backend runs on this
// machine (e.g. a host service with its own T3 home), so it can open editors locally.
export function sharesDesktopHostMachine(input: {
  readonly isDesktopRenderer: boolean;
  readonly remoteOpenTargets: ReadonlyArray<RemoteOpenTarget> | undefined;
  readonly hostRemoteOpenTargets?: ReadonlyArray<RemoteOpenTarget> | undefined;
}): boolean {
  if (!input.isDesktopRenderer) return false;
  const hostTargets = input.hostRemoteOpenTargets ?? [];
  return (input.remoteOpenTargets ?? []).some((target) =>
    hostTargets.some(
      (hostTarget) =>
        hostTarget.kind === target.kind &&
        hostTarget.host === target.host &&
        hostTarget.username === target.username,
    ),
  );
}
