import {
  type GrokSettings,
  type ModelSelection,
  type ProviderOptionSelection,
  ProviderDriverKind,
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
  /** Optional process-level default applied via `grok agent --reasoning-effort`. */
  readonly reasoningEffort?: string | null | undefined;
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
  options?: {
    readonly reasoningEffort?: string | null | undefined;
  },
): AcpSessionRuntime.AcpSpawnInput {
  const effort = options?.reasoningEffort?.trim().toLowerCase();
  const effortArgs =
    effort && GROK_REASONING_EFFORT_MODE_IDS.has(effort)
      ? (["--reasoning-effort", effort] as const)
      : [];
  return {
    command: grokSettings?.binaryPath || "grok",
    args: ["agent", ...effortArgs, "stdio"],
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
        spawn: buildGrokAcpSpawnInput(input.grokSettings, input.cwd, input.environment, {
          reasoningEffort: input.reasoningEffort,
        }),
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
  const base = trimmed && trimmed.length > 0 ? trimmed : "grok-build";
  return normalizeModelSlug(base, GROK_DRIVER_KIND) ?? "grok-build";
}

export function currentGrokModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export interface GrokAcpModelSelectionErrorContext {
  readonly cause: EffectAcpErrors.AcpError;
  readonly step: "set-model" | "set-effort";
}

/**
 * Applies Grok model + reasoning effort.
 *
 * Grok ACP does not implement `session/set_config_option`. Reasoning effort is
 * selected via `session/set_mode` with mode ids like `high` / `medium` / `low`
 * (same channel as plan/default). Callers should skip effort when staying in
 * plan mode so plan is not overwritten.
 */
export function applyGrokAcpModelSelection<E>(input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "setSessionModel" | "setMode"
  >;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  /**
   * When false, skip applying effort via set_mode (e.g. plan interaction mode
   * owns the mode channel). Defaults to true.
   */
  readonly applyReasoningEffort?: boolean;
  readonly mapError: (context: GrokAcpModelSelectionErrorContext) => E;
}): Effect.Effect<string | undefined, E> {
  return Effect.gen(function* () {
    let boundModelId = input.currentModelId;
    const shouldSwitchModel =
      input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
    if (shouldSwitchModel && input.requestedModelId) {
      yield* input.runtime
        .setSessionModel(input.requestedModelId)
        .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-model" })));
      boundModelId = input.requestedModelId;
    }

    if (input.applyReasoningEffort === false) {
      return boundModelId;
    }

    const effort = resolveGrokReasoningEffortSelection(input.selections);
    if (!effort) {
      return boundModelId;
    }

    yield* input.runtime
      .setMode(effort)
      .pipe(Effect.mapError((cause) => input.mapError({ cause, step: "set-effort" })));
    return boundModelId;
  });
}
