export interface ServerCandidate {
  readonly source: "paired" | "desktop" | "configured";
  readonly url: string;
}

export function normalizeServerUrl(value: string | null): string | null {
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
  pairedServerUrl: string | null = null,
): ReadonlyArray<ServerCandidate> {
  const paired = normalizeServerUrl(pairedServerUrl);
  const desktop = normalizeServerUrl(desktopServerUrl);
  const configured = normalizeServerUrl(configuredServerUrl);
  const candidates: Array<ServerCandidate> = [];
  // An explicit pairing is the strongest signal of intent, and it is the only
  // endpoint the paired bearer token may be sent to, so try it first.
  if (paired !== null) candidates.push({ source: "paired", url: paired });
  if (desktop !== null && desktop !== paired) candidates.push({ source: "desktop", url: desktop });
  if (configured !== null && configured !== desktop && configured !== paired) {
    candidates.push({ source: "configured", url: configured });
  }
  return candidates;
}

/**
 * Paired bearer tokens stay pinned to their issuer. Legacy or manually entered tokens have no endpoint pin.
 */
export function bearerTokenAppliesTo(
  tokenEndpoint: string | null,
  targetServerUrl: string,
): boolean {
  const scope = normalizeServerUrl(tokenEndpoint);
  if (scope === null) return true;
  return scope === normalizeServerUrl(targetServerUrl);
}
