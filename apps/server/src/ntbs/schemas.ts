/**
 * Describes the platform-specific data of a
 * Non-Turn-Based-Surface.
 *
 * When receiving an NTBS event (a comment, a message tagging
 * a bot, etc) `source` and `responseDestination` hold the details
 * necessary to process the what and why.
 */
export type PlatformData<Source = unknown, ResponseDestination = unknown> = {
  source: Source;
  responseDestination: ResponseDestination;
};

export type LifecycleEvent<P extends PlatformData> = {
  /**
   * Each NTBSEvent carries the adapter-defined external data.
   * T3 never inspects it. Only the adapter deals with it.
   */
  platformData: P;
  /**
   * The captured source text used to send the first T3 user message.
   * Platform-independent.
   */
  snapshot: string;
};

export type ThreadEvent<P extends PlatformData> = LifecycleEvent<P> & {
  t3Data: {
    /** The T3 thread created by the lifecycle event */
    threadId: string;
  };
};

export type RequestAccepted<P extends PlatformData> = LifecycleEvent<P> & {
  state: "request.accepted";
};

export type ThreadStarted<P extends PlatformData> = ThreadEvent<P> & {
  /** T3 has created the new thread from the source snapshot */
  state: "thread.started";
};

export type ThreadStartedAcknowledgement<P extends PlatformData> = ThreadEvent<P> & {
  state: "thread.started.acknowledged";
  /** the external's platform identification of the acknowledgment message */
  acknowledgementMessageId: string;
};

export type ResponseAvailable<P extends PlatformData> = ThreadEvent<P> & {
  state: "thread.response.available";
  /** the external's platform identification of the acknowledgment message */
  acknowledgementMessageId: string;
};

export type ResponsePosted<P extends PlatformData> = ThreadEvent<P> & {
  state: "thread.response.posted";
  /** the external's platform identification of the acknowledgment message */
  acknowledgementMessageId: string;
  responseMessageId: string;
};

export type NTBSLifecycle<P extends PlatformData> =
  | RequestAccepted<P>
  | ThreadStarted<P>
  | ThreadStartedAcknowledgement<P>
  | ResponseAvailable<P>
  | ResponsePosted<P>;
