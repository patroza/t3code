import { type KimiSettings, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";

import { applyKimiAcpModelSelection, makeKimiAcpRuntime } from "../acp/KimiAcpSupport.ts";
import { makeAcpCliAdapter, type AcpCliAdapterOptions } from "./CursorAdapter.ts";

const PROVIDER = ProviderDriverKind.make("kimi");
export const KIMI_TURN_COMPLETION_SETTLE_DELAY = "2 seconds";

export function makeKimiAdapter(
  settings: KimiSettings,
  options?: AcpCliAdapterOptions<KimiSettings>,
) {
  return makeAcpCliAdapter(
    settings,
    {
      provider: PROVIDER,
      providerName: "Kimi Code",
      defaultInstanceId: ProviderInstanceId.make("kimi"),
      makeRuntime: (currentSettings, input) => makeKimiAcpRuntime(currentSettings, input),
      applyModelSelection: applyKimiAcpModelSelection,
      resolveModelId: (model) => model?.trim() ?? "",
      turnCompletionSettleDelay: KIMI_TURN_COMPLETION_SETTLE_DELAY,
    },
    options,
  );
}
