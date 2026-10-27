import { assert, it } from "@effect/vitest";

import { ProviderThreadId } from "@t3tools/contracts";

import {
  legacyImportAlreadyInNativeThread,
  shouldPrepareLegacyImportHandoff,
} from "./Orchestrator.ts";

it("reissues imported context until a V2 run completes", () => {
  assert.isTrue(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: true,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: undefined,
      hasCompletedRun: false,
      legacyImportItemCount: 2,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 0,
    }),
  );
  assert.isFalse(
    shouldPrepareLegacyImportHandoff({
      historyOrigin: "v1_import",
      hasCompletedRun: false,
      legacyImportItemCount: 2,
      alreadyInNativeThread: true,
    }),
  );
});

it("treats an inlined v1 import as already in that native session", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread:grok");
  const delivered = {
    strategy: "manual_context" as const,
    fromProviderThreadIds: [],
    toProviderThreadId: providerThreadId,
    delivery: {
      nativeThreadId: "native-1",
      status: "inline" as const,
      itemIds: [],
    },
  };
  assert.isTrue(
    legacyImportAlreadyInNativeThread({
      providerThreadId,
      nativeThreadId: "native-1",
      handoffs: [delivered],
    }),
  );
  assert.isFalse(
    legacyImportAlreadyInNativeThread({
      providerThreadId,
      nativeThreadId: "native-1",
      handoffs: [{ ...delivered, delivery: { ...delivered.delivery, status: "pending" } }],
    }),
  );
  assert.isFalse(
    legacyImportAlreadyInNativeThread({
      providerThreadId,
      nativeThreadId: undefined,
      handoffs: [delivered],
    }),
  );
});
