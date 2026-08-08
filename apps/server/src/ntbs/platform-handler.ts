import { Context, Data, Effect } from "effect";

export class NTBSPlatformHandlerError extends Data.TaggedError("NTBSPlatformHandlerError")<{
  reason: string;
}> {}

/**
 * Connects a platform's incoming messages or comments to shared NTBS processor.
 *
 * It determines whether the input should start work. If so, it captures the platform data,
 * source snapshot, and T3 context, then passes them to the processor.
 *
 * Duplicate detection, lifecycle storage, and platform API calls belong to the adapter.
 */
export interface NTBSPlatformHandler<Input> {
  readonly handle: (input: Input) => Effect.Effect<void, NTBSPlatformHandlerError>;
}

/**
 * Creates the Effect service tag used to provide and access one platform handler.
 *
 * This identifies the handler in the Effect context.
 * It does not create the handler implementation.
 */
export const makeNTBSPlatformHandlerTag = <Input>(key: string) =>
  Context.Service<NTBSPlatformHandler<Input>>(key);
