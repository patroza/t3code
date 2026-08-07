import * as NTBS from "./schemas.ts";
import { Context, Data, Effect } from "effect";

export class ThreadNotFound extends Data.TaggedError("ThreadNotFound") {}

/**
 * Generic error catcher, will be refined later
 */
export class AdapterError extends Data.TaggedError("AdapterError")<{
  readonly reason: string;
}> {}

export interface NTBSAdapter<P extends NTBS.PlatformData> {
  readonly accept: (
    event: NTBS.RequestAccepted<P>,
  ) => Effect.Effect<"accepted" | "duplicate", AdapterError>;
  readonly save: (lifecycleEvent: NTBS.NTBSLifecycle<P>) => Effect.Effect<void, AdapterError>;
  readonly postAcknowledgement: (
    event: NTBS.ThreadStarted<P>,
  ) => Effect.Effect<string, AdapterError>;
  readonly postResponse: (
    event: NTBS.ResponseAvailable<P>,
    text: string,
  ) => Effect.Effect<string, AdapterError>;
  readonly findByThreadId: (
    threadId: string,
  ) => Effect.Effect<
    Exclude<NTBS.NTBSLifecycle<P>, NTBS.RequestAccepted<P>>,
    ThreadNotFound | AdapterError
  >;
}

export const makeNTBSAdapter = <P extends NTBS.PlatformData>(key: string) =>
  Context.Service<NTBSAdapter<P>>(key);
