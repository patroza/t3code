import {
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  ScheduledTaskId,
} from "@t3tools/contracts";

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

/** Older scheduled messages stored their attribution in the prompt itself. */
export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId;
}): {
  readonly text: string;
  /** Who sent a user-role message the user did not type. */
  readonly attribution: "automation" | "agent" | "t3code" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
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
    text: message.text,
    // Restart continuations were sent as the agent before they became notices.
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}
