export type PairingInput =
  | { readonly kind: "url"; readonly pairingUrl: string }
  | { readonly kind: "code"; readonly host: string; readonly pairingCode: string };

/**
 * Classify raw user input as either a full pairing URL (anything containing
 * "://") or a bare pairing token to be resolved against a fallback server.
 * The real parsing is left to `resolveRemotePairingTarget` from
 * `@t3tools/shared/remote`, whose typed errors are fine to let bubble.
 */
export function classifyPairingInput(raw: string, fallbackServerUrl: string): PairingInput {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("Enter a pairing URL or pairing token.");
  if (trimmed.includes("://")) return { kind: "url", pairingUrl: trimmed };
  return { kind: "code", host: fallbackServerUrl, pairingCode: trimmed };
}

const DAY_IN_SECONDS = 86_400;
const HOUR_IN_SECONDS = 3_600;
const MINUTE_IN_SECONDS = 60;

/** Rough human-readable lifetime for the success message, e.g. "~30 days". */
export function describeTokenExpiry(expiresInSeconds: number): string {
  if (!Number.isFinite(expiresInSeconds) || expiresInSeconds <= 0) return "unknown duration";
  if (expiresInSeconds >= DAY_IN_SECONDS) {
    return `~${Math.round(expiresInSeconds / DAY_IN_SECONDS)} days`;
  }
  if (expiresInSeconds >= HOUR_IN_SECONDS) {
    return `~${Math.round(expiresInSeconds / HOUR_IN_SECONDS)} hours`;
  }
  if (expiresInSeconds >= MINUTE_IN_SECONDS) {
    return `~${Math.round(expiresInSeconds / MINUTE_IN_SECONDS)} minutes`;
  }
  return "~1 minute";
}
