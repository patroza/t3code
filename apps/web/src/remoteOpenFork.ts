import type { EnvironmentId } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import * as Option from "effect/Option";

import { isLoopbackHostname } from "~/environments/primary/target";
import { environmentSession } from "~/state/session";

// A paired environment reached over its loopback route ("This device") runs on the viewing
// machine, e.g. a host service with its own T3 home next to the desktop app, so editors open
// locally instead of through an SSH link back to this machine.
export function isReachedOverLoopback(activeHttpBaseUrl: string | undefined): boolean {
  if (activeHttpBaseUrl === undefined) return false;
  try {
    return isLoopbackHostname(new URL(activeHttpBaseUrl).hostname);
  } catch {
    return false;
  }
}

/** Whether this environment's route in use is loopback; keeps its Open in action visible. */
export function useIsReachedOverLoopback(environmentId: EnvironmentId): boolean {
  const connection = useAtomValue(environmentSession.preparedConnectionValueAtom(environmentId));
  return isReachedOverLoopback(Option.getOrUndefined(connection)?.httpBaseUrl);
}
