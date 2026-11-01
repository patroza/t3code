import {
  type ChatAttachment,
  type ChatFileAttachment,
  type GuestMessageAttribution,
  type OrchestrationMessageContext,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2IdleCompaction,
  type OrchestrationV2UserMessageInputIntent,
  ScheduledTaskId,
} from "@t3tools/contracts";
import {
  isAttachmentOnlyBootstrapPrompt,
  replaceComposerContextReferences,
} from "@t3tools/shared/composerContextReferences";
import { filePreviewKind } from "@t3tools/shared/filePreview";
import { imageMimeType } from "@t3tools/shared/image";
import { videoMimeType } from "@t3tools/shared/video";

/** The working row while T3 Code's own compaction runs. */
export const IDLE_COMPACTING_LABELS = {
  beforeCacheExpires: "Compacting before the cache expires…",
  onReturn: "Compacting…",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

/** Leads the finished compaction's token counts, in place of "Context compacted". */
export const IDLE_COMPACTION_TITLES = {
  beforeCacheExpires: "Context automatically compacted before cache expiry",
  onReturn: "Context compacted before sending",
} satisfies Record<OrchestrationV2IdleCompaction, string>;

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

/** Provenance the timeline can read. Person fields are server-stamped. */
export interface MessageSenderSource {
  readonly channel?: string | null | undefined;
  readonly personId?: string | null | undefined;
  readonly username?: string | null | undefined;
  readonly actor?:
    | {
        readonly displayName?: string | null | undefined;
      }
    | null
    | undefined;
}

/** Who is looking, plus the source channel of this client. */
export interface MessageSenderViewer {
  readonly personId?: string | null | undefined;
  readonly username?: string | null | undefined;
  readonly channel?: string | null | undefined;
  /**
   * False while this client's session claim is still loading. Same-channel
   * messages stay unlabeled until then, so your own send does not flash a name.
   */
  readonly identityReady?: boolean | undefined;
}

const SENT_BY_ANOTHER_AGENT = "Sent by another agent";

function normalizedIdentity(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function identityKeys(
  personId: string | null | undefined,
  username: string | null | undefined,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const value of [personId, username]) {
    const key = normalizedIdentity(value);
    if (key.length > 0) keys.add(key);
  }
  return keys;
}

function sharesPerson(
  source: MessageSenderSource | null | undefined,
  viewer: MessageSenderViewer | null | undefined,
): boolean {
  const sourceKeys = identityKeys(source?.personId, source?.username);
  if (sourceKeys.size === 0) return false;
  const viewerKeys = identityKeys(viewer?.personId, viewer?.username);
  for (const key of sourceKeys) {
    if (viewerKeys.has(key)) return true;
  }
  return false;
}

/** Username, else the first word of the display name, else the person id. */
function senderHandle(source: MessageSenderSource | null | undefined): string | undefined {
  const username = source?.username?.trim();
  if (username) return username;
  const displayName = source?.actor?.displayName?.trim();
  if (displayName) {
    const [first] = displayName.split(/\s+/);
    if (first) return first;
  }
  const personId = source?.personId?.trim();
  return personId ? personId : undefined;
}

/**
 * Label for a user message this client did not send.
 * Same person and same source: hidden. Same person elsewhere: the source only.
 * Anyone else: `username@source`.
 */
export function messageSenderCaption(input: {
  readonly source: MessageSenderSource | null | undefined;
  readonly viewer?: MessageSenderViewer | null | undefined;
}): string | undefined {
  const channel = input.source?.channel?.trim();
  if (!channel) return undefined;
  const viewerChannel = input.viewer?.channel?.trim() ?? "";
  const sameChannel = viewerChannel.length > 0 && viewerChannel === channel;
  const identityReady = input.viewer?.identityReady !== false;
  if (!identityReady && sameChannel) return undefined;
  if (sharesPerson(input.source, input.viewer)) {
    return sameChannel ? undefined : channel;
  }
  if (identityKeys(input.source?.personId, input.source?.username).size === 0) {
    return sameChannel ? undefined : channel;
  }
  const handle = senderHandle(input.source);
  return handle ? `${handle}@${channel}` : channel;
}

/**
 * Caption for one user-role timeline message.
 * A message source wins. An agent message with none uses the thread origin.
 * No source at all stays unlabeled, except an agent message, which keeps the
 * generic line.
 */
export function userMessageSenderCaption(input: {
  readonly createdBy?: "user" | "agent" | "system" | null | undefined;
  readonly source?: MessageSenderSource | null | undefined;
  readonly originSource?: MessageSenderSource | null | undefined;
  readonly viewer?: MessageSenderViewer | null | undefined;
}): string | undefined {
  const source =
    input.source ?? (input.createdBy === "agent" ? (input.originSource ?? undefined) : undefined);
  if (source) return messageSenderCaption({ source, viewer: input.viewer });
  return input.createdBy === "agent" ? SENT_BY_ANOTHER_AGENT : undefined;
}

/** User messages that already carry a sender, keyed by message id. */
export function indexUserMessageSources(
  messages:
    | ReadonlyArray<{
        readonly id: string;
        readonly role: string;
        readonly source?: MessageSenderSource | null | undefined;
      }>
    | null
    | undefined,
): ReadonlyMap<string, MessageSenderSource> {
  const sources = new Map<string, MessageSenderSource>();
  for (const message of messages ?? []) {
    if (message.role === "user" && message.source?.channel) {
      sources.set(message.id, message.source);
    }
  }
  return sources;
}

export function resolveUserMessageFileCards(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}): ReadonlyArray<ChatFileAttachment> | null {
  const files = message.attachments.filter(
    (attachment): attachment is ChatFileAttachment =>
      attachment.type === "file" &&
      imageMimeType(attachment) === null &&
      videoMimeType(attachment) === null &&
      filePreviewKind(attachment) !== "audio",
  );
  if (files.length === 0 || files.length !== message.attachments.length) return null;
  const fileIds = new Set(files.map((file) => file.id));
  const remaining = replaceComposerContextReferences(message.text, (reference) => {
    const record = message.context?.records.find((item) => item.contextId === reference.contextId);
    return reference.kind === "file" &&
      record?.kind === "file" &&
      "attachmentId" in record &&
      fileIds.has(record.attachmentId)
      ? ""
      : reference.label || reference.kind;
  });
  return remaining.trim() === "" ? files : null;
}

/** Older scheduled messages stored their attribution in the prompt itself. */
export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId | undefined;
  readonly context?: { readonly guest?: GuestMessageAttribution | undefined } | undefined;
}): {
  readonly text: string;
  readonly attribution: "automation" | "agent" | "t3code" | "guest" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
  /** Set when `attribution` is "guest". */
  readonly guestName?: string;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  // The stored text names the guest for the agent; people see the guest's own words.
  const guest = message.context?.guest;
  if (guest !== undefined) {
    return {
      text: guest.text,
      attribution: "guest",
      scheduledTaskId: undefined,
      guestName: guest.name,
    };
  }
  if (message.scheduledTaskId !== undefined) {
    return {
      text: message.text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(message.text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: message.text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    // The agent needs words to start a turn; people sent only the attachments.
    text: isAttachmentOnlyBootstrapPrompt(message.text) ? "" : message.text,
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}

type GroupableUserMessage = Parameters<typeof resolveUserMessagePresentation>[0] & {
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
};

export function resolveUserMessageGrouping(
  message: GroupableUserMessage | undefined,
  previous: GroupableUserMessage | undefined,
  next: GroupableUserMessage | undefined,
) {
  const isOwnMessage = (value: GroupableUserMessage | undefined) =>
    value?.role === "user" && resolveUserMessagePresentation(value).attribution === null;
  const isSteer = (value: GroupableUserMessage | undefined) =>
    value?.inputIntent === "steer" || value?.inputIntent === "promoted_queued_to_steer";
  const groupedWithPrevious = isOwnMessage(message) && isOwnMessage(previous);
  return {
    groupedWithPrevious,
    groupedWithNext: isOwnMessage(message) && isOwnMessage(next),
    continuesSteer: groupedWithPrevious && isSteer(message) && isSteer(previous),
  };
}
