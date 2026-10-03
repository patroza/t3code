import { useAtomValue } from "@effect/atom-react";
import {
  claimPersonIdForEnvironment,
  isClaimedNonStarterParticipant,
} from "@t3tools/client-runtime/state/identity";
import type { ThreadParticipantSummary } from "@t3tools/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { identityClaimPersonIdByEnvironmentAtom } from "../../state/identity";
import { IdentityAvatar } from "./IdentityAvatar";

/**
 * Creator micro-avatar + +N for thread list rows (mirrors web ParticipantStack).
 * Long-press / accessibility label carries the expanded roster; dense RN lists
 * skip hover popovers.
 */
export function ParticipantStack(props: {
  readonly environmentId: string;
  readonly participants: ReadonlyArray<ThreadParticipantSummary>;
  readonly channel?: string | null | undefined;
  readonly className?: string | undefined;
}) {
  const people = props.participants;
  const claimPersonIdByEnvironment = useAtomValue(identityClaimPersonIdByEnvironmentAtom);
  const claimPersonId = claimPersonIdForEnvironment(
    claimPersonIdByEnvironment,
    props.environmentId,
  );
  const youParticipated = isClaimedNonStarterParticipant({
    claimPersonId,
    participants: people,
  });
  if (people.length === 0) return null;

  const lead = people[0]!;
  const extras = people.slice(1);
  const label =
    extras.length === 0
      ? `Started by ${lead.username}`
      : `Started by ${lead.username}, ${extras.length} other participant${extras.length === 1 ? "" : "s"}`;
  const accessibleLabel = youParticipated ? `${label}. You participated` : label;

  return (
    <View
      accessibilityLabel={accessibleLabel}
      accessibilityRole="text"
      className={cn("flex-row items-center gap-0.5 shrink-0", props.className)}
      testID="participant-stack"
    >
      <View className="relative shrink-0 pr-0.5">
        <IdentityAvatar
          personId={lead.personId}
          username={lead.username}
          name={lead.name}
          size="micro"
          highlighted={lead.personId === claimPersonId}
        />
        <SourceChannelGlyph channel={props.channel ?? lead.firstChannel} overlay />
      </View>
      {extras.length > 0 ? (
        <View
          accessibilityElementsHidden={!youParticipated}
          importantForAccessibility={youParticipated ? "auto" : "no-hide-descendants"}
          accessibilityLabel={youParticipated ? "You participated" : undefined}
          className={cn(
            "size-3.5 items-center justify-center rounded-full",
            youParticipated ? "border border-primary bg-primary/15" : "bg-subtle",
          )}
          testID={youParticipated ? "you-participated-indicator" : undefined}
        >
          <Text
            className={cn(
              "text-[8px] font-t3-medium",
              youParticipated ? "text-primary" : "text-foreground-tertiary",
            )}
          >
            +{extras.length}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

export function SourceChannelGlyph(props: {
  readonly channel: string | null | undefined;
  readonly overlay?: boolean;
  readonly className?: string | undefined;
}) {
  if (!props.channel) return null;
  const short =
    props.channel === "desktop"
      ? "D"
      : props.channel === "web"
        ? "W"
        : props.channel === "mobile"
          ? "M"
          : props.channel === "discord"
            ? "Δ"
            : props.channel === "jira"
              ? "J"
              : props.channel === "github"
                ? "G"
                : props.channel.slice(0, 1).toUpperCase();
  return (
    <View
      accessibilityLabel={`Source ${props.channel}`}
      accessibilityRole="text"
      className={cn(
        props.overlay
          ? "absolute -bottom-0.5 -right-0.5 size-2.5 items-center justify-center rounded-full border border-border bg-background"
          : "size-3.5 shrink-0 items-center justify-center rounded border border-border opacity-70",
        props.className,
      )}
      testID="source-channel-glyph"
    >
      <Text
        className={cn(
          "font-t3-bold text-foreground-tertiary",
          props.overlay ? "text-[6px]" : "text-[8px]",
        )}
      >
        {short}
      </Text>
    </View>
  );
}

/** Optional trailing metadata that never changes a thread title's alignment. */
export function ThreadIdentityMark(props: {
  readonly environmentId: string;
  readonly originChannel?: string | null | undefined;
  readonly participants?: ReadonlyArray<ThreadParticipantSummary> | null | undefined;
  readonly className?: string | undefined;
}) {
  const participants = props.participants ?? [];
  const channel = props.originChannel ?? participants[0]?.firstChannel ?? null;
  if (!channel && participants.length === 0) return null;
  if (participants.length === 0) {
    return <SourceChannelGlyph channel={channel} className={props.className} />;
  }
  return (
    <ParticipantStack
      environmentId={props.environmentId}
      participants={participants}
      channel={channel}
      className={props.className}
    />
  );
}
