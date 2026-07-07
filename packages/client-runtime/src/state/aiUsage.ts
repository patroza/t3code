import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "./runtime.ts";

/**
 * Environment atoms for the local `ai-usage` daemon feed. A single streaming
 * subscription per environment carries the latest usage snapshot; the server
 * only polls the daemon while at least one client is subscribed.
 */
export function createAiUsageEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:ai-usage:snapshot",
      tag: WS_METHODS.subscribeAiUsage,
    }),
  };
}
