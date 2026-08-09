import type { ThreadId } from "@t3tools/contracts";
import * as NTBS from "./lifecycle.ts";
import { Context, Data, Effect } from "effect";

export class ThreadNotFound extends Data.TaggedError("ThreadNotFound") {}

/**
 * Generic error catcher, will be refined later
 */
export class AdapterError extends Data.TaggedError("AdapterError")<{
  readonly reason: string;
}> {}

export type NTBSResponse = {
  readonly type: "answer" | "failure" | "timeout" | "cancellation";
  readonly text: string;
};

/**
 * Defines the platform-specific operations used by the shared NTBS processor.
 *
 * The adapter detects duplicate requests, stores lifecycle data, finds that data
 * from a T3 thread ID, and posts acknowledgements and responses.
 *
 * The adapter owns its storage and retention policy. A stored snapshot may
 * outlive the original platform message. E.g. a message on Discord gets deleted
 * but its still persisted in the original snapshot.
 * Verify retention policies.
 *
 * It does not create T3 threads or interpret T3 events.
 */
export interface NTBSAdapter<P extends NTBS.PlatformData> {
  /**
   * Stores a lifecycle state. Does not perform any other business logic.
   */
  readonly save: (lifecycleEvent: NTBS.NTBSLifecycle<P>) => Effect.Effect<void, AdapterError>;
  /**
   * Posts the working acknowledgement at the response destination,
   * described by the event.
   *
   * Returns the platform's identifier for the posted message.
   */
  readonly postAcknowledgement: (
    state: NTBS.ThreadStarted<P>,
  ) => Effect.Effect<string, AdapterError>;
  /**
   * Posts the final T3 outcome at the response destination described
   * by the event.
   *
   * Returns the platform's idenitifier for the posted message.
   * The processor uses that identifier to save `ResponsePosted`.
   */
  readonly postResponse: (
    state: NTBS.ThreadStarted<P>,
    response: NTBSResponse,
  ) => Effect.Effect<string, AdapterError>;
  /**
   * Searches the response destination for a matching response previously
   * posted by this adapter.
   *
   * Returns the platform message ID when found, or `null` when no matching
   * message exists.
   */
  readonly findMatchingResponseMessage: (
    state: NTBS.ThreadStarted<P>,
    response: NTBSResponse,
  ) => Effect.Effect<string | null, AdapterError>;
  /**
   * Finds the latest lifecycle state associated with a T3 thread.
   *
   * Fails with `ThreadNotFound` when this adapter has no request associated
   * with that thread.
   */
  readonly findByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<NTBS.NTBSLifecycle<P>, ThreadNotFound | AdapterError>;
  /**
   * Loads records that reached `ThreadStarted` but have no recorded
   * `ResponsePosted` state.
   */
  readonly loadThreadsAwaitingResponse: Effect.Effect<
    ReadonlyArray<NTBS.ThreadStarted<P>>,
    AdapterError
  >;
}

export const makeNTBSAdapterTag = <P extends NTBS.PlatformData>(key: string) =>
  Context.Service<NTBSAdapter<P>>(key);
