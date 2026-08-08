import type { ThreadId } from "@t3tools/contracts";
import * as NTBS from "./schemas.ts";
import { Context, Data, Effect } from "effect";

export class ThreadNotFound extends Data.TaggedError("ThreadNotFound") {}

/**
 * Generic error catcher, will be refined later
 */
export class AdapterError extends Data.TaggedError("AdapterError")<{
  readonly reason: string;
}> {}

/**
 * Defines the platform-specific operations used by the shared NTBS processor.
 *
 * The adapter detects duplicate requests, stores lifecycle data, finds that data
 * from a T3 thread ID, and posts acknowledgements and responses.
 *
 * It does not create T3 threads or interpret T3 events.
 */
export interface NTBSAdapter<P extends NTBS.PlatformData> {
  /**
   * Stores the request before any T3 work begins.
   *
   * Returns `"duplicate"` if the same platform request was already stored.
   *
   * Returning `"accepted"` means this `RequestAccepted` state has been stored.
   */
  readonly accept: (
    event: NTBS.RequestAccepted<P>,
  ) => Effect.Effect<"accepted" | "duplicate", AdapterError>;
  /**
   * Stores a lifecycle state. Does not perform any other business logic.
   */
  readonly save: (lifecycleEvent: NTBS.NTBSLifecycle<P>) => Effect.Effect<void, AdapterError>;
  /**
   * Posts the working acknowledgement at the response destination,
   * described by the event.
   *
   * Returns the platform's identifier for the posted message.
   *
   * The processor uses that identifier to save `ThreadStartedAcknowledgement`.
   */
  readonly postAcknowledgement: (
    event: NTBS.ThreadStarted<P>,
  ) => Effect.Effect<string, AdapterError>;
  /**
   * Posts the final T3 outcome at the response destination described
   * by the event.
   *
   * Returns the platform's idenitifier for the posted message.
   * The processor uses that identifier to save `ResponsePosted`.
   */
  readonly postResponse: (
    event: NTBS.ResponseAvailable<P>,
    text: string,
  ) => Effect.Effect<string, AdapterError>;
  /**
   * Finds the latest lifecycle state associated with a T3 thread.
   *
   * Fails with `ThreadNotFound` when this adapter has no request associated
   * with that thread.
   */
  readonly findByThreadId: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Exclude<NTBS.NTBSLifecycle<P>, NTBS.RequestAccepted<P>>,
    ThreadNotFound | AdapterError
  >;
}

export const makeNTBSAdapterTag = <P extends NTBS.PlatformData>(key: string) =>
  Context.Service<NTBSAdapter<P>>(key);
