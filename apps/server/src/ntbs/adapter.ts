import type { ReplyPending, ThreadCreated, UndeliverableCause } from "./exchange.ts";
import { Context, Data, Effect } from "effect";

/**
 * A platform operation failed without establishing that reply delivery is
 * permanently impossible. The processor may retry the operation later.
 */
export class AdapterError extends Data.TaggedError("AdapterError")<{
  readonly reason: string;
  readonly cause: unknown;
}> {}

/** The platform definitively rejected delivery of a pending reply. */
export class ReplyRejected extends Data.TaggedError("ReplyRejected")<{
  readonly cause: UndeliverableCause;
}> {}

/**
 * Defines the platform-specific operations used by the shared NTBS processor.
 *
 * An adapter communicates with one originating platform. It posts
 * acknowledgements and replies, and can discover whether a particular pending
 * reply was already posted. It does not persist exchange state, create T3
 * threads, or interpret T3 events.
 */
export interface NTBSAdapter {
  /**
   * Posts a best-effort working acknowledgement for an exchange whose T3
   * thread now exists. The acknowledgement is not part of the durable exchange
   * lifecycle and its platform identifier is not retained.
   */
  readonly acknowledge: (state: ThreadCreated) => Effect.Effect<void, AdapterError>;

  /**
   * Posts the exact reply stored in `state` to the destination identified by
   * its `sourceUri`.
   *
   * Returns an adapter-encoded URI locating the posted reply. `ReplyRejected`
   * means the platform definitively refused delivery; other failures remain
   * retryable.
   */
  readonly postReply: (state: ReplyPending) => Effect.Effect<string, AdapterError | ReplyRejected>;

  /**
   * Searches for the exact pending reply in case it was posted before the
   * corresponding `ReplyPosted` state could be persisted.
   *
   * Returns its adapter-encoded source URI when found, or `null` otherwise.
   */
  readonly findPostedReply: (state: ReplyPending) => Effect.Effect<string | null, AdapterError>;
}

/**
 * One tag for every platform. A processor resolves its adapter from the context it is built in, so each one is given the implementation for its own platform.
 */
export const NTBSAdapter = Context.Service<NTBSAdapter>("t3code/ntbs/adapter");
