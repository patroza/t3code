import {
  indexUserMessageSources,
  type MessageSenderSource,
  type MessageSenderViewer,
  userMessageSenderCaption,
} from "@t3tools/client-runtime/message-sender";
import type { EnvironmentId, SourceChannel } from "@t3tools/contracts";
import { sourceChannelFromDeviceType } from "@t3tools/shared/sourceAttribution";
import { use } from "react";

import { clientPresentationMetadata } from "../../connection/clientMetadata";
import { identityEnvironment } from "../../state/identity";
import { useEnvironmentQuery } from "../../state/query";
import type { ChatMessage } from "../../types";
import { TimelineRowCtx } from "./timelineRowContext";

/** Who is reading the timeline and who sent each user message. */
export interface MessageSenderContext {
  readonly viewer: MessageSenderViewer;
  /** Thread origin, used when an agent message has no sender of its own. */
  readonly originSource: MessageSenderSource | null | undefined;
  readonly sourceById: ReadonlyMap<string, MessageSenderSource>;
}

const EMPTY_INPUT = {} as const;

/** Source channel of the client running this page. Web is not a device type. */
function currentClientSourceChannel(): SourceChannel {
  if (typeof navigator === "undefined") return "unknown";
  return sourceChannelFromDeviceType(
    clientPresentationMetadata({
      appVersion: "0.0.0",
      hosted: false,
      identity: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        maxTouchPoints: navigator.maxTouchPoints,
      },
      desktopBridge: typeof window === "undefined" ? undefined : window.desktopBridge,
    }).deviceType,
  );
}

/** ChatView hook: sender context for one thread's timeline. */
export function useMessageSenderContext(input: {
  readonly environmentId: EnvironmentId | null;
  readonly messages:
    | ReadonlyArray<{
        readonly id: string;
        readonly role: string;
        readonly source?: MessageSenderSource | null | undefined;
      }>
    | null
    | undefined;
  readonly originSource: MessageSenderSource | null | undefined;
}): MessageSenderContext {
  const claim = useEnvironmentQuery(
    input.environmentId === null
      ? null
      : identityEnvironment.sessionClaim({
          environmentId: input.environmentId,
          input: EMPTY_INPUT,
        }),
  );
  return {
    viewer: {
      personId: claim.data?.claim?.personId,
      username: claim.data?.claim?.username,
      channel: currentClientSourceChannel(),
      identityReady: claim.isSuccess,
    },
    originSource: input.originSource,
    sourceById: indexUserMessageSources(input.messages),
  };
}

/**
 * `username@channel` above a user message someone else sent. Agent messages without a
 * recorded sender keep upstream's own folded presentation, so they get no caption here.
 */
export function MessageSenderCaption(props: { readonly message: ChatMessage }) {
  const sender = use(TimelineRowCtx).messageSender;
  if (sender === undefined) return null;
  const source = sender.sourceById.get(props.message.id);
  if (source === undefined && (props.message.createdBy !== "agent" || !sender.originSource)) {
    return null;
  }
  const caption = userMessageSenderCaption({
    createdBy: props.message.createdBy,
    source,
    originSource: sender.originSource,
    viewer: sender.viewer,
  });
  if (caption === undefined) return null;
  return (
    <p
      className="me-1 text-2xs text-muted-foreground/70"
      data-user-message-attribution="sender"
      data-testid="message-sender-caption"
    >
      {caption}
    </p>
  );
}
