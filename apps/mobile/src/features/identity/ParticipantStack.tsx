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
  readonly className?: string;
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
      <IdentityAvatar
        personId={lead.personId}
        username={lead.username}
        name={lead.name}
        size="micro"
      />
      {extras.length > 0 ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="size-3.5 items-center justify-center rounded-full bg-subtle"
        >
          <Text className="text-[8px] font-t3-medium text-foreground-tertiary">
            +{extras.length}
          </Text>
        </View>
      ) : null}
      {youParticipated ? (
        <View
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          className="size-3.5 items-center justify-center rounded-full border border-primary bg-primary/15"
          testID="you-participated-indicator"
        >
          <Text className="text-[9px] font-t3-bold text-primary">✓</Text>
        </View>
      ) : null}
    </View>
  );
}

export function SourceChannelGlyph(props: {
  readonly channel: string | null | undefined;
  readonly className?: string;
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
        "size-3.5 shrink-0 items-center justify-center rounded border border-border",
        props.className,
      )}
      testID="source-channel-glyph"
    >
      <Text className="text-[8px] font-t3-bold text-foreground-tertiary">{short}</Text>
    </View>
  );
}

/** Leading channel glyph + participant stack for a thread shell row. */
export function ThreadIdentityLeading(props: {
  readonly environmentId: string;
  readonly originChannel?: string | null | undefined;
  readonly participants?: ReadonlyArray<ThreadParticipantSummary> | null | undefined;
  readonly className?: string;
}) {
  const participants = props.participants ?? [];
  const channel = props.originChannel ?? participants[0]?.firstChannel ?? null;
  if (!channel && participants.length === 0) return null;
  return (
    <View className={cn("flex-row items-center gap-1 shrink-0", props.className)}>
      <SourceChannelGlyph channel={channel} />
      <ParticipantStack environmentId={props.environmentId} participants={participants} />
    </View>
  );
}
