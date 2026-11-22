import { useAtomValue } from "@effect/atom-react";
import {
  indexUserMessageSources,
  messageSenderCaption,
} from "@t3tools/client-runtime/message-sender";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { sourceChannelFromDeviceType } from "@t3tools/shared/sourceAttribution";
import { useMemo } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { authClientMetadata } from "../../lib/authClientMetadata";
import { identityEnvironment } from "../../state/identity";
import { environmentThreads } from "../../state/threads";
import { useEnvironmentQuery } from "../../state/query";

const EMPTY_SESSION_CLAIM_INPUT = {} as const;

/** Thread projection senders by message id; turn items do not carry the source. */
const messageSourcesAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = key.split("\0") as [EnvironmentId, ThreadId];
  return Atom.make((get) => {
    const state = AsyncResult.getOrElse(
      get(environmentThreads.stateAtom(environmentId, threadId)),
      () => null,
    );
    return indexUserMessageSources(
      state === null ? undefined : Option.getOrUndefined(state.data)?.messages,
    );
  }).pipe(Atom.withLabel("mobile-identity:message-sources"));
});

/** Only a change to this message's own sender re-renders its caption. */
const messageSourceAtom = Atom.family((key: string) => {
  const separator = key.lastIndexOf("\0");
  const threadKey = key.slice(0, separator);
  const messageId = key.slice(separator + 1);
  return Atom.make((get) => get(messageSourcesAtom(threadKey)).get(messageId)).pipe(
    Atom.withLabel("mobile-identity:message-source"),
  );
});

/**
 * `username@channel` above a user message someone else sent. Your own message from this
 * client stays unlabeled; messages without a server-stamped source keep upstream's labels.
 */
export function MessageSenderCaption(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string;
}) {
  const source = useAtomValue(
    messageSourceAtom(`${props.environmentId}\0${props.threadId}\0${props.messageId}`),
  );
  const sessionClaimTarget = useMemo(
    () => ({ environmentId: props.environmentId, input: EMPTY_SESSION_CLAIM_INPUT }),
    [props.environmentId],
  );
  const sessionClaim = useEnvironmentQuery(identityEnvironment.sessionClaim(sessionClaimTarget));
  const label = messageSenderCaption({
    source,
    viewer: {
      personId: sessionClaim.data?.claim?.personId,
      username: sessionClaim.data?.claim?.username,
      channel: sourceChannelFromDeviceType(authClientMetadata().deviceType),
      identityReady: sessionClaim.data !== null && sessionClaim.error === null,
    },
  });
  if (!label) return null;
  return (
    <Text className="mb-1 pr-1 font-t3-medium text-2xs text-foreground-muted opacity-60">
      {label}
    </Text>
  );
}
