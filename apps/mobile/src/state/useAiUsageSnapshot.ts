import type { AiUsageSnapshot, EnvironmentId } from "@t3tools/contracts";

import { aiUsageEnvironment } from "./aiUsage";
import { useEnvironmentQuery } from "./query";

/** Subscribe to an environment's AI-usage snapshot (null until available). */
export function useAiUsageSnapshot(environmentId: EnvironmentId | null): AiUsageSnapshot | null {
  const query = useEnvironmentQuery(
    environmentId === null ? null : aiUsageEnvironment.snapshot({ environmentId, input: {} }),
  );
  return query.data ?? null;
}
