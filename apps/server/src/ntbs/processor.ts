import { type OrchestrationEvent, type ProjectId } from "@t3tools/contracts";
import type * as NTBS from "./schemas.ts";
import { Context, Data, Effect } from "effect";

/*
  NTBS architectural description:
  1. Generic NTBS processor:
    - Contains the shared workflow for every adapter. The business logic, regardless of the actual NTBS is identical
    - Makes queries to the specific platform adapter
    - Uses private T3-specific effect to create a fresh thread and worktree, then starts the turn with `snapshot`
    - Saves `ThreadStarted`
    - Posts to the NTBS platform through the adapter and saves `ThreadStartAcknowledgment`

    - Watches T3 events for completed work.
    - Finds the adapter record by T3 thread ID, posts the final result
    and saves `ResponseAvailable` and `ResponsePosted`

  2. Platform handler
    - Receives raw platform data (Jira, Discord, Github, Teams)
    - Builds `RequestAccepted<P> and `T3Context`
    - Calls the processor

  3. Adapter
    - Owns platform storage, duplicate detection and platform API calls
    - Knows how to post acknowledgments and responses
    - Knows how platform identifiers are represented
    - Knows nothing about creating T3 threads or interpreting T3 events
*/

export type T3Context = {
  readonly projectId: ProjectId;
  readonly revision: string;
};

export type ProcessorEvent<P extends NTBS.PlatformData> =
  | {
      readonly source: "adapter";
      readonly event: NTBS.RequestAccepted<P>;
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

  readonly subscribeToT3Events: () => Effect.Effect<void>;
}

export const makeNTBSProcessor = <P extends NTBS.PlatformData>(key: string) =>
  Context.Service<NTBSProcessor<P>>(key);

declare const processAcceptedRequest: <P extends NTBS.PlatformData>(
  request: NTBS.RequestAccepted<P>,
  t3Context: T3Context,
) => Effect.Effect<void, NTBSProcessorError>;

declare const processT3Event: <P extends NTBS.PlatformData>(
  event: OrchestrationEvent,
) => Effect.Effect<void, NTBSProcessorError>;
