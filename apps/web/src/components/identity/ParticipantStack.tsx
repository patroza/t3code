import { useAtomValue } from "@effect/atom-react";
import {
  claimPersonIdForEnvironment,
  isClaimedNonStarterParticipant,
} from "@t3tools/client-runtime/state/identity";
import type { ThreadParticipantSummary } from "@t3tools/contracts";
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
  readonly channel?: string | null | undefined;
  readonly className?: string | undefined;
  /**
   * When false the stack is inert: no tab stop and no tooltip trigger. Drag
   * clones are `aria-hidden`, and a focusable element inside one is reachable
   * by keyboard while being hidden from assistive technology.
   */
  readonly interactive?: boolean | undefined;
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
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 opacity-75 transition-opacity hover:opacity-100 focus:opacity-100",
        props.className,
      )}
      data-testid="participant-stack"
      aria-label={accessibleLabel}
      {...(props.interactive === false ? {} : { tabIndex: 0 })}
    >
      <span className="relative inline-flex shrink-0 pr-0.5">
        <IdentityAvatar
          personId={lead.personId}
          username={lead.username}
          name={lead.name}
          size="micro"
          title={null}
          highlighted={lead.personId === claimPersonId}
        />
        <SourceChannelGlyph channel={props.channel ?? lead.firstChannel} overlay />
      </span>
      {extras.length > 0 ? (
        <span
          className={cn(
            "inline-flex size-3.5 items-center justify-center rounded-full text-[8px] font-medium",
            youParticipated
              ? "bg-primary/15 text-primary ring-1 ring-primary/35"
              : "bg-muted text-muted-foreground",
          )}
          aria-hidden={!youParticipated}
          aria-label={youParticipated ? "You participated" : undefined}
          data-testid={youParticipated ? "you-participated-indicator" : undefined}
        >
          +{extras.length}
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
              highlighted={person.personId === claimPersonId}
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
    <span
      className={cn(
        props.overlay
          ? "absolute -bottom-0.5 -right-0.5 inline-flex size-2.5 items-center justify-center rounded-full bg-sidebar text-[6px] font-semibold text-muted-foreground ring-1 ring-border/80"
          : "inline-flex size-3.5 shrink-0 items-center justify-center rounded text-[8px] font-semibold text-muted-foreground/70 ring-1 ring-border/60",
        props.className,
      )}
      data-testid="source-channel-glyph"
      aria-label={`Source ${props.channel}`}
    >
      {short}
    </span>
  );
}

/**
 * Optional identity metadata for a thread row. It belongs after the flexible
 * title so identity-capable and identity-unavailable hosts keep the same title
 * alignment and row geometry.
 */
export function ThreadIdentityMark(props: {
  readonly environmentId: string;
  readonly originChannel?: string | null | undefined;
  readonly participants?: ReadonlyArray<ThreadParticipantSummary> | null | undefined;
  readonly className?: string | undefined;
  /** Pass false inside an aria-hidden clone; see {@link ParticipantStack}. */
  readonly interactive?: boolean | undefined;
}) {
  const participants = props.participants ?? [];
  const channel = props.originChannel ?? participants[0]?.firstChannel ?? null;
  if (participants.length === 0) {
    return <SourceChannelGlyph channel={channel} className={props.className} />;
  }
  return (
    <ParticipantStack
      environmentId={props.environmentId}
      participants={participants}
      channel={channel}
      className={props.className}
      interactive={props.interactive}
    />
  );
}
