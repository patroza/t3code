export interface ServerCandidate {
  readonly source: "desktop" | "configured";
  readonly url: string;
}

function normalizeServerUrl(value: string | null): string | null {
  if (value === null || value.trim() === "") return null;
  return new URL(value).toString();
}

/**
 * Prefer the backend advertised by the T3 process running beside this
 * extension host. A configured localhost URL may be synced between machines
 * or refer to a VS Code-forwarded port, so it is only a fallback.
 */
export function serverCandidates(
  desktopServerUrl: string | null,
  configuredServerUrl: string,
): ReadonlyArray<ServerCandidate> {
  const desktop = normalizeServerUrl(desktopServerUrl);
  const configured = normalizeServerUrl(configuredServerUrl);
  const candidates: Array<ServerCandidate> = [];
  if (desktop !== null) candidates.push({ source: "desktop", url: desktop });
  if (configured !== null && configured !== desktop) {
    candidates.push({ source: "configured", url: configured });
  }
  return candidates;
}
