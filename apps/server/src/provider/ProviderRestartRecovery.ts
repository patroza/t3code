import { ModelSelection, ProviderInteractionMode, TurnId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isModelSelection = Schema.is(ModelSelection);
const isProviderInteractionMode = Schema.is(ProviderInteractionMode);
const isTurnId = Schema.is(TurnId);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readPersistedProviderCwd(runtimePayload: unknown): string | undefined {
  if (!isRecord(runtimePayload)) return undefined;
  const cwd = runtimePayload.cwd;
  if (typeof cwd !== "string") return undefined;
  const trimmed = cwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function readPersistedProviderModelSelection(
  runtimePayload: unknown,
): ModelSelection | undefined {
  if (!isRecord(runtimePayload)) return undefined;
  return isModelSelection(runtimePayload.modelSelection)
    ? runtimePayload.modelSelection
    : undefined;
}

export function readPersistedProviderInteractionMode(
  runtimePayload: unknown,
): ProviderInteractionMode | undefined {
  if (!isRecord(runtimePayload)) return undefined;
  return isProviderInteractionMode(runtimePayload.interactionMode)
    ? runtimePayload.interactionMode
    : undefined;
}

export function readPersistedProviderActiveTurnId(runtimePayload: unknown): TurnId | undefined {
  if (!isRecord(runtimePayload)) return undefined;
  return isTurnId(runtimePayload.activeTurnId) ? runtimePayload.activeTurnId : undefined;
}
