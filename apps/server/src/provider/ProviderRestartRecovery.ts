import {
  IsoDateTime,
  ModelSelection,
  ProviderInteractionMode,
  TurnId,
  type ProviderSessionRuntimeStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PROVIDER_RESTART_RECOVERY_PAYLOAD_KEY = "restartRecovery";

export const ProviderRestartRecoveryMarker = Schema.Struct({
  version: Schema.Literal(1),
  interruptedProviderTurnId: Schema.NullOr(TurnId),
  shutdownAt: IsoDateTime,
});
export type ProviderRestartRecoveryMarker = typeof ProviderRestartRecoveryMarker.Type;

export interface ProviderRestartRecoveryCandidate extends ProviderRestartRecoveryMarker {
  readonly source: "marker" | "legacy-active-turn";
}

const isProviderRestartRecoveryMarker = Schema.is(ProviderRestartRecoveryMarker);
const isModelSelection = Schema.is(ModelSelection);
const isProviderInteractionMode = Schema.is(ProviderInteractionMode);
const isTurnId = Schema.is(TurnId);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function makeProviderRestartRecoveryMarker(input: {
  readonly interruptedProviderTurnId: TurnId | null | undefined;
  readonly shutdownAt: string;
}): ProviderRestartRecoveryMarker {
  return {
    version: 1,
    interruptedProviderTurnId: input.interruptedProviderTurnId ?? null,
    shutdownAt: IsoDateTime.make(input.shutdownAt),
  };
}

export function readProviderRestartRecoveryMarker(
  runtimePayload: unknown,
): ProviderRestartRecoveryMarker | undefined {
  if (!isRecord(runtimePayload)) return undefined;
  const marker = runtimePayload[PROVIDER_RESTART_RECOVERY_PAYLOAD_KEY];
  return isProviderRestartRecoveryMarker(marker) ? marker : undefined;
}

export function readProviderRestartRecoveryCandidate(input: {
  readonly runtimePayload: unknown;
  readonly status: ProviderSessionRuntimeStatus | undefined;
  readonly lastSeenAt: string;
}): ProviderRestartRecoveryCandidate | undefined {
  const marker = readProviderRestartRecoveryMarker(input.runtimePayload);
  if (marker !== undefined) {
    return { ...marker, source: "marker" };
  }
  if (input.status !== "starting" && input.status !== "running") {
    return undefined;
  }
  if (!isRecord(input.runtimePayload)) return undefined;
  const activeTurnId = input.runtimePayload.activeTurnId;
  if (!isTurnId(activeTurnId)) return undefined;
  return {
    version: 1,
    interruptedProviderTurnId: activeTurnId,
    shutdownAt: IsoDateTime.make(input.lastSeenAt),
    source: "legacy-active-turn",
  };
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
