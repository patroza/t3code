import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import { makeAcpTextGeneration } from "./AcpTextGeneration.ts";

it.effect("refuses Kimi review guide investigation before starting an ACP runtime", () =>
  Effect.gen(function* () {
    let runtimeStarted = false;
    const textGeneration = yield* makeAcpTextGeneration(
      { binaryPath: "kimi" },
      {
        providerName: "Kimi Code",
        makeRuntime: () => {
          runtimeStarted = true;
          return Effect.die("Unexpected ACP runtime");
        },
        applyModelSelection: () => Effect.void,
      },
    );
    const error = yield* textGeneration
      .generateReviewGuide({
        cwd: "/repo",
        number: 1,
        title: "Review a change",
        description: "",
        baseBranch: "main",
        baseCommit: "base",
        settledReview: "",
        modelSelection: createModelSelection(ProviderInstanceId.make("kimi"), "kimi-for-coding"),
      })
      .pipe(Effect.flip);
    expect(error).toMatchObject({
      _tag: "TextGenerationError",
      operation: "generateReviewGuide",
    });
    expect(error.detail).toContain("Kimi Code cannot investigate a checkout read-only");
    expect(runtimeStarted).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);
