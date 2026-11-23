import { isLoopbackHostname } from "~/environments/primary/target";

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
