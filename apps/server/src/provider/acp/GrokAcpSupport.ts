import {
  GROK_DEFAULT_MODEL,
  type GrokSettings,
  type ModelSelection,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  ProviderDriverKind,
  type RuntimeMode,
} from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionStringSelectionValue,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import { makeXAiPromptCompletionRuntime } from "./XAiAcpExtension.ts";

/** Preferred Grok ACP mode when the T3 thread is in Plan. */
export const GROK_PLAN_MODE_ID = "plan";
/** Preferred Grok ACP mode when the T3 thread is in Build (default). */
export const GROK_AGENT_MODE_ID = "agent";

const GROK_API_KEY_ENV = "XAI_API_KEY";
const GROK_OAUTH2_REFERRER_ENV = "GROK_OAUTH2_REFERRER";
const T3_CODE_OAUTH_REFERRER = "t3code";
const GROK_AUTH_METHOD_API_KEY = "xai.api_key";
const GROK_AUTH_METHOD_CACHED_TOKEN = "cached_token";
const GROK_DRIVER_KIND = ProviderDriverKind.make("grok");

/** Grok ACP applies reasoning effort through `session/set_mode` mode ids. */
const GROK_REASONING_EFFORT_MODE_IDS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

export const GROK_REASONING_EFFORT_OPTION_ID = "reasoningEffort";

type GrokAcpRuntimeGrokSettings = Pick<GrokSettings, "binaryPath">;

interface GrokAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly grokSettings: GrokAcpRuntimeGrokSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeMode?: RuntimeMode;
  /** Optional process-level default applied via `grok agent --reasoning-effort`. */
  readonly reasoningEffort?: string | null | undefined;
}

export function grokAcpSpawnArgs(runtimeMode?: RuntimeMode): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "approval-required":
      return ["--permission-mode", "default", "agent", "stdio"];
    case "auto-accept-edits":
      return ["--permission-mode", "acceptEdits", "agent", "stdio"];
    case "auto":
      return ["--permission-mode", "auto", "agent", "stdio"];
    case "full-access":
      return ["agent", "--always-approve", "stdio"];
    default:
      return ["agent", "stdio"];
  }
}

function withReasoningEffort(
  args: ReadonlyArray<string>,
  reasoningEffort?: string | null,
): ReadonlyArray<string> {
  const effort = reasoningEffort?.trim().toLowerCase();
  if (!effort || !GROK_REASONING_EFFORT_MODE_IDS.has(effort)) {
    return args;
  }
  const agentIndex = args.indexOf("agent");
  if (agentIndex === -1) {
    return [...args, "--reasoning-effort", effort];
  }
  return [
    ...args.slice(0, agentIndex + 1),
    "--reasoning-effort",
    effort,
    ...args.slice(agentIndex + 1),
  ];
}

export function resolveGrokReasoningEffortSelection(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): string | undefined {
  const fromReasoning = getProviderOptionStringSelectionValue(
    selections,
    GROK_REASONING_EFFORT_OPTION_ID,
  );
  const raw = fromReasoning ?? getProviderOptionStringSelectionValue(selections, "effort");
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed || !GROK_REASONING_EFFORT_MODE_IDS.has(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function resolveGrokReasoningEffortFromModelSelection(
  modelSelection: ModelSelection | null | undefined,
): string | undefined {
  if (!modelSelection) {
    return undefined;
  }
  const raw =
    getModelSelectionStringOptionValue(modelSelection, GROK_REASONING_EFFORT_OPTION_ID) ??
    getModelSelectionStringOptionValue(modelSelection, "effort");
  const trimmed = raw?.trim().toLowerCase();
  if (!trimmed || !GROK_REASONING_EFFORT_MODE_IDS.has(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function buildGrokAcpSpawnInput(
  grokSettings: GrokAcpRuntimeGrokSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
  runtimeMode?: RuntimeMode,
  options?: {
    readonly reasoningEffort?: string | null | undefined;
  },
): AcpSessionRuntime.AcpSpawnInput {
  return {
    command: grokSettings?.binaryPath || "grok",
    args: withReasoningEffort(grokAcpSpawnArgs(runtimeMode), options?.reasoningEffort),
    cwd,
    env: {
      ...environment,
      [GROK_OAUTH2_REFERRER_ENV]: T3_CODE_OAUTH_REFERRER,
    },
    ...(environment ? { extendEnv: false } : {}),
  };
}

function resolveGrokAuthMethodId(environment: NodeJS.ProcessEnv | undefined): string {
  return environment?.[GROK_API_KEY_ENV]?.trim()
    ? GROK_AUTH_METHOD_API_KEY
    : GROK_AUTH_METHOD_CACHED_TOKEN;
}

export const makeGrokAcpRuntime = (
  input: GrokAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildGrokAcpSpawnInput(
          input.grokSettings,
          input.cwd,
          input.environment,
          input.runtimeMode,
          { reasoningEffort: input.reasoningEffort },
        ),
        authMethodId: resolveGrokAuthMethodId(input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
    return yield* makeXAiPromptCompletionRuntime(runtime);
  });

export function resolveGrokAcpBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim();
  const base = trimmed && trimmed.length > 0 ? trimmed : GROK_DEFAULT_MODEL;
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? GROK_DEFAULT_MODEL;
}

const GROK_REASONING_EFFORT_TOKEN = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

export function isValidGrokReasoningEffortToken(value: string): boolean {
  return GROK_REASONING_EFFORT_TOKEN.test(value);
}

export function normalizeGrokReasoningEffort(value: string | undefined): string | undefined {
  const effort = value?.trim();
  return effort && isValidGrokReasoningEffortToken(effort) ? effort : undefined;
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function currentGrokReasoningEffortFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  const modelState = sessionSetupResult.models;
  if (!modelState) {
    return undefined;
  }
  const currentModelId = modelState.currentModelId.trim();
  if (currentModelId.length === 0) {
    return undefined;
  }
  const currentModel = modelState.availableModels.find(
    (model) => model.modelId.trim() === currentModelId,
  );
  const reasoningEffort = currentModel?._meta?.reasoningEffort;
  return typeof reasoningEffort === "string"
    ? normalizeGrokReasoningEffort(reasoningEffort)
    : undefined;
}

export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly currentReasoningEffort?: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly requestedReasoningEffort?: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const modelChanged =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  const reasoningProvided = input.requestedReasoningEffort !== undefined;
  const reasoningEffort = reasoningProvided
    ? normalizeGrokReasoningEffort(input.requestedReasoningEffort)
    : undefined;
  const reasoningEffortChanged =
    reasoningProvided && reasoningEffort !== input.currentReasoningEffort;
  const targetModelId = input.requestedModelId ?? input.currentModelId;
  if ((!modelChanged && !reasoningEffortChanged) || targetModelId === undefined) {
    return Effect.succeed(input.currentModelId);
  }
  const reasoningMeta =
    reasoningProvided && reasoningEffort !== undefined ? { reasoningEffort } : undefined;
  // When reasoning was explicitly provided but invalid (normalize => undefined), we deliberately
  // send no meta so the invalid value is dropped rather than forwarded. When reasoning was not
  // provided at all, we also send no meta, but we only reach this call when the model itself
  // changed - an omitted reasoning preference must not be treated as an explicit clear of the
  // CLI-advertised default (e.g. Extra High) on same-model reselections.
  return input.runtime
    .setSessionModel(targetModelId, reasoningMeta)
    .pipe(Effect.mapError(input.mapError), Effect.as(targetModelId));
}

/**
 * Maps T3 interaction mode onto Grok ACP session modes.
 * Build/default/unset always targets agent mode; Plan targets plan mode.
 * Never selects ask mode — that was leaving Grok read-only/approval-heavy in Build.
 *
 * Kept in lockstep with `resolveGrokAcpModeIdForInteractionMode` in GrokPlanMode.
 */
export function resolveGrokRequestedModeId(
  interactionMode: ProviderInteractionMode | undefined,
): string {
  return interactionMode === "plan" ? GROK_PLAN_MODE_ID : GROK_AGENT_MODE_ID;
}

export function applyGrokAcpSessionMode<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setMode">;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string, E> {
  const modeId = resolveGrokRequestedModeId(input.interactionMode);
  return input.runtime.setMode(modeId).pipe(Effect.mapError(input.mapError), Effect.as(modeId));
}
