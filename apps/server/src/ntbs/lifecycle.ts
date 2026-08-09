import type { ChatAttachment, MessageId, ThreadId } from "@t3tools/contracts";

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

export type NTBSInput<P extends PlatformData> = {
  /**
   * Each NTBSEvent carries the adapter-defined external data.
   * T3 never inspects it. Only the adapter deals with it.
   */
  platformData: P;
  /**
   * The captured source text sent as the first T3 user message.
   * Platform independent.
   * Must not exceed T3's 120,000-character input limit.
   */
  snapshot: string;
  /**
   * References to attachments stored by T3 and sent with the first user message.
   * The processor creates them from attachment data provided by the adapter.
   */
  attachments: ReadonlyArray<ChatAttachment>;
};

export type ThreadEvent<P extends PlatformData> = NTBSInput<P> & {
  t3Data: {
    /** The T3 thread created by the lifecycle event */
    threadId: ThreadId;
    /**
     * The first T3 user message created for this external request.
     * This identifies the correct turn and response even if the thread later
     * receives other messages.
     */
    userMessageId: MessageId;
  };
};

export type ThreadStarted<P extends PlatformData> = ThreadEvent<P> & {
  /** T3 has created the new thread. */
  state: "thread.started";
};

export type ResponsePosted<P extends PlatformData> = ThreadEvent<P> & {
  state: "thread.response.posted";
  responseMessageId: string;
};

export type NTBSLifecycle<P extends PlatformData> = ThreadStarted<P> | ResponsePosted<P>;
