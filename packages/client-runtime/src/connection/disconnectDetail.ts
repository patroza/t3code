/**
 * Short, user-safe connection failure text for UI + diagnostics.
 * Prefer a close code or known cause over the bare "disconnected." message.
 */

export interface SocketCloseCapture {
  readonly code?: number | undefined;
  readonly reason?: string | undefined;
}

export interface FormatDisconnectDetailInput {
  readonly label: string;
  readonly wasConnected: boolean;
  readonly close?: SocketCloseCapture | undefined;
  /** Underlying transport message when available (e.g. "ping timeout"). */
  readonly causeMessage?: string | undefined;
}

const MAX_REASON_CHARS = 48;

/** Well-known WebSocket close codes we surface by short name. */
export function describeWebSocketCloseCode(code: number): string | null {
  switch (code) {
    case 1000:
      return "clean";
    case 1001:
      return "going away";
    case 1002:
      return "protocol error";
    case 1003:
      return "unsupported data";
    case 1005:
      return "no status";
    case 1006:
      return "abnormal";
    case 1007:
      return "bad data";
    case 1008:
      return "policy violation";
    case 1009:
      return "too large";
    case 1011:
      return "server error";
    case 1012:
      return "service restart";
    case 1013:
      return "try again later";
    case 1014:
      return "bad gateway";
    case 1015:
      return "TLS failed";
    default:
      return null;
  }
}

function sanitizeCloseReason(reason: string | undefined): string | null {
  if (typeof reason !== "string") return null;
  const trimmed = reason.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length <= MAX_REASON_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_REASON_CHARS - 1)}…`;
}

function normalizeCauseMessage(message: string | undefined): string | null {
  if (typeof message !== "string") return null;
  const trimmed = message.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return null;
  // Drop generic Effect wrappers; keep the useful tail.
  const lower = trimmed.toLowerCase();
  if (lower.includes("ping timeout")) return "ping timeout";
  if (lower.includes("socketcloseerror")) {
    const match = trimmed.match(/SocketCloseError[:\s]*([^\n]+)/i);
    return match?.[1]?.trim() ?? "socket closed";
  }
  if (lower.includes("socketopenerror")) return "socket open failed";
  if (lower === "socket is not connected") return "socket not connected";
  return null;
}

/**
 * Full detail string stored on ConnectionTransientError / shown as secondary UI text.
 */
export function formatDisconnectDetail(input: FormatDisconnectDetailInput): string {
  const label = input.label.trim() || "Environment";
  const cause = normalizeCauseMessage(input.causeMessage);
  const code = input.close?.code;
  const codeName =
    typeof code === "number" && Number.isFinite(code) ? describeWebSocketCloseCode(code) : null;
  const closeReason = sanitizeCloseReason(input.close?.reason);

  if (!input.wasConnected) {
    if (cause) return `${label} could not open WebSocket (${cause}).`;
    // Our open-timeout path closes with 1000; that is not useful "clean" signal.
    const usefulOpenClose =
      typeof code === "number" && !(code === 1000 && (closeReason === null || closeReason === ""));
    if (usefulOpenClose) {
      const bits = [`${code}${codeName ? ` ${codeName}` : ""}`, closeReason].filter(Boolean);
      return `${label} could not open WebSocket (${bits.join(": ")}).`;
    }
    return `${label} could not open WebSocket.`;
  }

  if (cause === "ping timeout") {
    return `${label} ping timeout.`;
  }

  if (typeof code === "number") {
    const head = `${code}${codeName ? ` ${codeName}` : ""}`;
    if (
      closeReason &&
      closeReason.toLowerCase() !== (codeName ?? "").toLowerCase() &&
      !head.toLowerCase().includes(closeReason.toLowerCase())
    ) {
      return `${label} closed (${head}: ${closeReason}).`;
    }
    return `${label} closed (${head}).`;
  }

  if (cause) return `${label} disconnected (${cause}).`;
  return `${label} disconnected.`;
}

/**
 * Compact fragment for inline status lines (no trailing period).
 */
export function formatDisconnectStatusFragment(detail: string): string {
  return detail.replace(/\.$/, "").trim();
}
