export const DEFAULT_SERVER_URL = "http://127.0.0.1:3773";

export interface ServerCandidate {
  readonly source: "desktop" | "configured";
  readonly url: string;
}

/**
 * `normalizeServerUrl` parses with `new URL(...)`, so an unparseable configured
 * value throws while connecting rather than where it was entered. Validate at
 * entry to keep that failure out of the connection path.
 */
export function serverUrlValidationMessage(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return `Enter a server URL, for example ${DEFAULT_SERVER_URL}`;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return `Enter a valid absolute URL, for example ${DEFAULT_SERVER_URL}`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return "The server URL must use http or https.";
  }
  return null;
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
