import { TurnId } from "@t3tools/contracts";

/** Runtime payload key shared by in-app server updates and graceful process stop. */
export const SERVER_UPDATE_CONTINUATION_KEY = "continueAfterServerUpdate";
export const SERVER_UPDATE_CONTINUATION_PROMPT = "Continue where you left off.";

export function readRuntimePayload(runtimePayload: unknown): Record<string, unknown> {
  return runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload)
    ? (runtimePayload as Record<string, unknown>)
    : {};
}

export function hasServerUpdateContinuationMarker(
  runtimePayload: unknown,
): runtimePayload is Record<string, unknown> {
  return (
    runtimePayload !== null &&
    typeof runtimePayload === "object" &&
    !Array.isArray(runtimePayload) &&
    SERVER_UPDATE_CONTINUATION_KEY in runtimePayload
  );
}

export function readServerUpdateContinuationTurnId(runtimePayload: unknown): TurnId | null {
  if (!hasServerUpdateContinuationMarker(runtimePayload)) {
    return null;
  }
  const value = runtimePayload[SERVER_UPDATE_CONTINUATION_KEY];
  return typeof value === "string" && value.length > 0 ? TurnId.make(value) : null;
}
