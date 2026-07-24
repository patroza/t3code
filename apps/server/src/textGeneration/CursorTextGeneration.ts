import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  type CursorSettings,
  type ModelSelection,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";
import { extractJsonObject } from "@t3tools/shared/schemaJson";

import { TextGenerationError } from "@t3tools/contracts";
import * as TextGeneration from "./TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildCommitMessagePrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "./TextGenerationPrompts.ts";
import {
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "./TextGenerationUtils.ts";
import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
  type CursorAcpRuntimeInput,
} from "../provider/acp/CursorAcpSupport.ts";
import type * as AcpSessionRuntime from "../provider/acp/AcpSessionRuntime.ts";
import type * as EffectAcpErrors from "effect-acp/errors";

const CURSOR_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

/**
 * Build a Cursor text-generation closure bound to a specific `CursorSettings`
 * payload. See `makeCodexAdapter` for the overall per-instance rationale.
 */
interface AcpTextGenerationSettings {
  readonly binaryPath: string;
}

export interface AcpTextGenerationDefinition<Settings extends AcpTextGenerationSettings> {
  readonly providerName: string;
  readonly makeRuntime: (
    settings: Settings,
    input: Omit<CursorAcpRuntimeInput, "cursorSettings">,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    Crypto.Crypto | import("effect/Scope").Scope
  >;
  readonly applyModelSelection: <E>(input: {
    readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
    readonly model: string | null | undefined;
    readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
    readonly mapError: (context: {
      readonly cause: EffectAcpErrors.AcpError;
      readonly step: "set-config-option" | "set-model";
      readonly configId?: string;
    }) => E;
  }) => Effect.Effect<void, E>;
}

export const makeAcpTextGeneration = Effect.fn("makeAcpTextGeneration")(function* <
  Settings extends AcpTextGenerationSettings,
>(
  settings: Settings,
  definition: AcpTextGenerationDefinition<Settings>,
  environment?: NodeJS.ProcessEnv,
) {
  const crypto = yield* Crypto.Crypto;
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const resolvedEnvironment = environment ?? process.env;

  const runAcpJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: ModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const outputRef = yield* Ref.make("");
      const runtime = yield* definition
        .makeRuntime(settings, {
          environment: resolvedEnvironment,
          childProcessSpawner: commandSpawner,
          cwd,
          clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
        })
        .pipe(Effect.provideService(Crypto.Crypto, crypto));

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* Effect.ignore(runtime.setMode("ask"));
        yield* definition.applyModelSelection({
          runtime,
          model: modelSelection.model,
          selections: modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            new TextGenerationError({
              operation,
              detail:
                step === "set-config-option"
                  ? `Failed to set ${definition.providerName} ACP config option "${configId}" for text generation.`
                  : `Failed to set ${definition.providerName} ACP base model for text generation.`,
              cause,
            }),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: `${definition.providerName} request timed out.`,
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: `${definition.providerName} ACP request failed.`,
                cause,
              }),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? `${definition.providerName} ACP request was cancelled.`
              : `${definition.providerName} returned empty output.`,
        });
      }

      const decodeOutput = Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson));
      return yield* decodeOutput(extractJsonObject(rawResult)).pipe(
        Effect.catchTags({
          SchemaError: (cause) =>
            Effect.fail(
              new TextGenerationError({
                operation,
                detail: `${definition.providerName} returned invalid structured output.`,
                cause,
              }),
            ),
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : new TextGenerationError({
              operation,
              detail: `${definition.providerName} ACP text generation failed.`,
              cause,
            }),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGeneration.TextGeneration["Service"]["generateCommitMessage"] =
    Effect.fn("CursorTextGeneration.generateCommitMessage")(function* (input) {
      const { prompt, outputSchema } = buildCommitMessagePrompt({
        branch: input.branch,
        stagedSummary: input.stagedSummary,
        stagedPatch: input.stagedPatch,
        includeBranch: input.includeBranch === true,
        policy: input.policy,
      });

      const generated = yield* runAcpJson({
        operation: "generateCommitMessage",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        subject: sanitizeCommitSubject(generated.subject),
        body: generated.body.trim(),
        ...("branch" in generated && typeof generated.branch === "string"
          ? { branch: sanitizeFeatureBranchName(generated.branch) }
          : {}),
      };
    });

  const generatePrContent: TextGeneration.TextGeneration["Service"]["generatePrContent"] =
    Effect.fn("CursorTextGeneration.generatePrContent")(function* (input) {
      const { prompt, outputSchema } = buildPrContentPrompt({
        baseBranch: input.baseBranch,
        headBranch: input.headBranch,
        commitSummary: input.commitSummary,
        diffSummary: input.diffSummary,
        diffPatch: input.diffPatch,
        policy: input.policy,
        changeRequestTemplate: input.changeRequestTemplate,
      });

      const generated = yield* runAcpJson({
        operation: "generatePrContent",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizePrTitle(generated.title),
        body: generated.body.trim(),
      };
    });

  const generateBranchName: TextGeneration.TextGeneration["Service"]["generateBranchName"] =
    Effect.fn("CursorTextGeneration.generateBranchName")(function* (input) {
      const { prompt, outputSchema } = buildBranchNamePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runAcpJson({
        operation: "generateBranchName",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        branch: sanitizeBranchFragment(generated.branch),
      };
    });

  const generateThreadTitle: TextGeneration.TextGeneration["Service"]["generateThreadTitle"] =
    Effect.fn("CursorTextGeneration.generateThreadTitle")(function* (input) {
      const { prompt, outputSchema } = buildThreadTitlePrompt({
        message: input.message,
        attachments: input.attachments,
      });

      const generated = yield* runAcpJson({
        operation: "generateThreadTitle",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        title: sanitizeThreadTitle(generated.title),
      } satisfies TextGeneration.ThreadTitleGenerationResult;
    });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
  } satisfies TextGeneration.TextGeneration["Service"];
});

export const makeCursorTextGeneration = (
  cursorSettings: CursorSettings,
  environment?: NodeJS.ProcessEnv,
) =>
  makeAcpTextGeneration(
    cursorSettings,
    {
      providerName: "Cursor",
      makeRuntime: (settings, input) =>
        makeCursorAcpRuntime({ ...input, cursorSettings: settings }),
      applyModelSelection: applyCursorAcpModelSelection,
    },
    environment,
  );
