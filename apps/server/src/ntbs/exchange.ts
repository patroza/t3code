import type { ChatAttachment, MessageId, ThreadId } from "@t3tools/contracts";

export type Request = {
  /**
   * Adapter-encoded URI locating the originating platform message,
   * e.g. `discord://<guildId>/<channelId>/<messageId>` or
   * `jira://<issueKey>/comment/<commentId>`.
   *
   * Two contracts:
   *
   * Identity — the same platform request must carry the same string
   * across redeliveries and restarts; distinct requests must carry
   * distinct strings. This is the durable dedup key `findByRequest`
   * looks up, the key the processor serializes concurrent deliveries
   * on, and the natural unique key for the adapter's stored records.
   *
   * Addressability — it must contain everything needed to reach the
   * message through the platform API from a cold start, because
   * recovery reposts with only the stored record. A Discord message
   * ID alone fails this: replying requires the channel ID too.
   *
   * Only the adapter that wrote it may parse it; the processor treats
   * it as an opaque string.
   */
  sourceUri: string;
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

type AcceptedRequest = Request & {
  t3: {
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

export type ThreadCreated = AcceptedRequest & {
  /**
   * T3 has created the new thread and the adapter has recorded its relationship
   * to the platform request. The first turn may not have started yet.
   */
  state: "thread.created";
};

export type ResponsePosted = AcceptedRequest & {
  state: "thread.response.posted";
  responseMessageId: string;
};

/**
 * The state of an exchange between an external platform and T3, from thread
 * creation through final-response delivery. Adapters store the latest state to
 * track progress and resume incomplete exchanges after a restart.
 */
export type ExchangeState = ThreadCreated | ResponsePosted;
