import {
  type KimiSettings,
  type ModelCapabilities,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import { makeKimiAcpRuntime } from "../acp/KimiAcpSupport.ts";
import {
  buildBooleanOptionDescriptor,
  buildSelectOptionDescriptor,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const PRESENTATION = {
  displayName: "Kimi Code",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_TIMEOUT_MS = 4_000;
const DISCOVERY_TIMEOUT_MS = 15_000;

function flattenSelectOptions(option: EffectAcpSchema.SessionConfigOption) {
  if (option.type !== "select") return [];
  return option.options.flatMap((entry) => ("value" in entry ? [entry] : entry.options));
}

function buildCapabilities(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ModelCapabilities {
  const optionDescriptors: Array<ProviderOptionDescriptor> = [];
  for (const option of configOptions) {
    const id = option.id.trim();
    if (!id || id === "model" || id === "mode") continue;
    if (option.type === "boolean") {
      optionDescriptors.push(
        buildBooleanOptionDescriptor({
          id,
          label: option.name.trim() || id,
          currentValue: option.currentValue,
          ...(option.description ? { description: option.description } : {}),
        }),
      );
      continue;
    }
    const choices = flattenSelectOptions(option)
      .filter((choice) => choice.value.trim().length > 0)
      .map((choice) => ({
        value: choice.value.trim(),
        label: choice.name.trim() || choice.value.trim(),
        isDefault: choice.value === option.currentValue,
      }));
    if (choices.length > 0) {
      optionDescriptors.push(
        buildSelectOptionDescriptor({
          id,
          label: option.name.trim() || id,
          options: choices,
          ...(option.description ? { description: option.description } : {}),
        }),
      );
    }
  }
  return createModelCapabilities({ optionDescriptors });
}

export function buildKimiModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const modelOption = configOptions.find(
    (option) => option.type === "select" && option.id.trim().toLowerCase() === "model",
  );
  if (!modelOption) return [];
  const capabilities = buildCapabilities(configOptions);
  const seen = new Set<string>();
  return flattenSelectOptions(modelOption).flatMap((model) => {
    const slug = model.value.trim();
    if (!slug || seen.has(slug)) return [];
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        capabilities,
      } satisfies ServerProviderModel,
    ];
  });
}

function modelsFromSettings(
  settings: Pick<KimiSettings, "customModels">,
  builtInModels: ReadonlyArray<ServerProviderModel> = [],
) {
  return providerModelsFromSettings(builtInModels, settings.customModels, EMPTY_CAPABILITIES);
}

export function buildInitialKimiProviderSnapshot(
  settings: KimiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: modelsFromSettings(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Kimi Code CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Kimi Code is disabled in T3 Code settings.",
          },
    }),
  );
}

const runVersionCommand = (settings: KimiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "kimi";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const discoverModels = (settings: KimiSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeKimiAcpRuntime(settings, {
      environment,
      childProcessSpawner,
      cwd: process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildKimiModelsFromConfigOptions(started.sessionSetupResult.configOptions ?? []);
  }).pipe(Effect.scoped);

export const checkKimiProviderStatus = Effect.fn("checkKimiProviderStatus")(function* (
  settings: KimiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = modelsFromSettings(settings);
  if (!settings.enabled) return yield* buildInitialKimiProviderSnapshot(settings);

  const versionResult = yield* runVersionCommand(settings, environment).pipe(
    Effect.timeoutOption(VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `Kimi Code CLI command \`${settings.binaryPath}\` was not found. Configure its absolute path in provider settings.`
          : "Failed to execute the Kimi Code CLI health check.",
      },
    });
  }
  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI timed out while running `kimi --version`.",
      },
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Kimi Code CLI is installed but failed to run.",
      },
    });
  }

  const discoveryExit = yield* discoverModels(settings, environment).pipe(
    Effect.timeoutOption(DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discoveryExit)) {
    yield* Effect.logWarning("Kimi ACP model discovery failed", {
      errorTag: causeErrorTag(discoveryExit.cause),
      causeDetail: Cause.pretty(discoveryExit.cause),
    });
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Kimi ACP startup failed. Run `kimi login`, then refresh the provider.",
      },
    });
  }
  const discovered = Option.isSome(discoveryExit.value) ? discoveryExit.value.value : [];
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: true,
    checkedAt,
    models: modelsFromSettings(settings, discovered),
    probe: {
      installed: true,
      version,
      status: discovered.length > 0 ? "ready" : "warning",
      auth: { status: "authenticated" },
      ...(discovered.length === 0 ? { message: "Kimi ACP returned no models." } : {}),
    },
  });
});

export const enrichKimiSnapshot = (input: {
  readonly settings: KimiSettings;
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly stampIdentity: (snapshot: ServerProvider) => ServerProvider;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  if (!input.settings.enabled || input.snapshot.auth.status === "unauthenticated")
    return Effect.void;
  return enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((snapshot) => input.publishSnapshot(input.stampIdentity(snapshot))),
    Effect.catchCause((cause) =>
      Effect.logWarning("Kimi version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
  );
};
