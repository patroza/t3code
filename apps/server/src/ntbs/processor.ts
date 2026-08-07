import type { OrchestrationEvent, ProjectId } from "@t3tools/contracts";
import type * as NTBS from "./schemas.ts";
import { Data, Effect, Scope } from "effect";

export type T3Context = {
  readonly projectId: ProjectId;
  readonly revision: string;
};

export type ProcessorEvent<P extends NTBS.PlatformData> =
  | {
      readonly source: "adapter";
      readonly event: NTBS.LifecycleEvent<P>;
      readonly t3Context: T3Context;
    }
  | {
      readonly source: "t3";
      readonly event: OrchestrationEvent;
    };

export class NTBSProcessorError extends Data.TaggedError("NTBSProcessorError")<{
  reason: string;
}> {}

export interface NTBSProcessor<P extends NTBS.PlatformData> {
  readonly process: (event: ProcessorEvent<P>) => Effect.Effect<void, NTBSProcessorError>;

  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
}
