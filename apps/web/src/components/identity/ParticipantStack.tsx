import { useAtomValue } from "@effect/atom-react";
import {
  claimPersonIdForEnvironment,
  isClaimedNonStarterParticipant,
} from "@t3tools/client-runtime/state/identity";
import type { ThreadParticipantSummary } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { identityClaimPersonIdByEnvironmentAtom } from "../../state/identity";
import { IdentityAvatar } from "./IdentityAvatar";
import { participantDisplayLabel } from "./ParticipantStack.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";

/**
 * Creator face + +N extras for thread list rows.
 * Hover/focus expands remaining participants (design: participant stack).
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

  const stack = (
    <span
      className={cn("inline-flex shrink-0 items-center gap-0.5", props.className)}
      data-testid="participant-stack"
      aria-label={accessibleLabel}
      tabIndex={0}
    >
      <IdentityAvatar
        personId={lead.personId}
        username={lead.username}
        name={lead.name}
        size="micro"
        title={null}
      />
      {extras.length > 0 ? (
        <span
          className="inline-flex size-3.5 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground"
          aria-hidden
        >
          +{extras.length}
        </span>
      ) : null}
      {youParticipated ? (
        <span
          className="inline-flex size-3.5 items-center justify-center rounded-full bg-primary/15 text-primary ring-1 ring-primary/35"
          aria-label="You participated"
          data-testid="you-participated-indicator"
        >
          <CheckIcon className="size-2.5" aria-hidden />
        </span>
      ) : null}
    </span>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={stack} />
      <TooltipPopup
        side="bottom"
        align="start"
        className="min-w-36 flex-col gap-1 p-1.5 text-xs"
        data-testid="participant-stack-popup"
      >
        {people.map((person) => (
          <span key={person.personId} className="flex items-center gap-1.5 px-0.5 py-0.5">
            <IdentityAvatar
              personId={person.personId}
              username={person.username}
              name={person.name}
              size="micro"
              title={null}
            />
            <span className="truncate text-foreground">
              {participantDisplayLabel(person)}
              {person.personId === claimPersonId ? (
                <span className="text-primary"> · You</span>
              ) : null}
            </span>
          </span>
        ))}
      </TooltipPopup>
    </Tooltip>
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
    <span
      className={cn(
        "inline-flex size-3.5 shrink-0 items-center justify-center rounded text-[8px] font-semibold text-muted-foreground ring-1 ring-border/70",
        props.className,
      )}
      title={props.channel}
      data-testid="source-channel-glyph"
      aria-label={`Source ${props.channel}`}
    >
      {short}
    </span>
  );
}
