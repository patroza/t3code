import * as NTBS from "./exchange.ts";
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
 * The adapter stores lifecycle data, finds that data from a T3 thread ID, and
 * posts acknowledgements and responses.
 *
 * The adapter owns its storage and retention policy. A stored snapshot may
 * outlive the original platform message. E.g. a message on Discord gets deleted
 * but its still persisted in the original snapshot.
 * Verify retention policies.
 *
 * It does not create T3 threads or interpret T3 events.
 */
export interface NTBSAdapter {
  /**
   * Posts the working acknowledgement at the response destination,
   * described by the event.
   *
   * Returns the platform's identifier for the posted message.
   */
  readonly acknowledge: (state: NTBS.ThreadCreated) => Effect.Effect<void, AdapterError>;
  /**
   * Posts the final T3 outcome at the response destination described
   * by the event.
   *
   * Returns the platform's idenitifier for the posted message.
   * The processor uses that identifier to save `ResponsePosted`.
   */
  readonly postReply: (
    state: NTBS.ThreadCreated,
    reply: NTBS.Reply,
  ) => Effect.Effect<string, AdapterError>;

  /**
   * Searches the response destination for a matching response previously
   * posted by this adapter.
   *
   * Returns the platform message ID when found, or `null` when no matching
   * message exists.
   */
  readonly findMatchingResponseMessage: (
    state: NTBS.ThreadCreated,
  ) => Effect.Effect<string | null, AdapterError>;
}

export const makeNTBSAdapterTag = (key: string) => Context.Service<NTBSAdapter>(key);
