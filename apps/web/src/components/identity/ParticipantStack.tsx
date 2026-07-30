import type { ThreadParticipantSummary } from "@t3tools/contracts";
import { IdentityAvatar } from "./IdentityAvatar";
import { cn } from "~/lib/utils";

/**
 * Creator face + +N extras for thread list rows.
 * Hover/focus expands remaining participants (design: participant stack).
 */
export function ParticipantStack(props: {
  readonly participants: ReadonlyArray<ThreadParticipantSummary>;
  readonly className?: string;
}) {
  const people = props.participants;
  if (people.length === 0) return null;

  const lead = people[0]!;
  const extras = people.slice(1);
  const label =
    extras.length === 0
      ? `Started by ${lead.username}`
      : `Started by ${lead.username}, ${extras.length} other participant${extras.length === 1 ? "" : "s"}`;

  return (
    <span
      className={cn(
        "group/stack relative inline-flex shrink-0 items-center gap-0.5",
        props.className,
      )}
      data-testid="participant-stack"
      aria-label={label}
      tabIndex={0}
    >
      <IdentityAvatar
        personId={lead.personId}
        username={lead.username}
        name={lead.name}
        size="micro"
        title={lead.firstChannel ? `${lead.username}@${lead.firstChannel}` : lead.username}
      />
      {extras.length > 0 ? (
        <span
          className="inline-flex size-3.5 items-center justify-center rounded-full bg-muted text-[8px] font-medium text-muted-foreground"
          aria-hidden
        >
          +{extras.length}
        </span>
      ) : null}
      {extras.length > 0 ? (
        <span
          role="tooltip"
          className="pointer-events-none absolute top-full left-0 z-50 mt-1 hidden min-w-36 flex-col gap-1 rounded-md border border-border/80 bg-popover p-1.5 text-xs shadow-md group-focus-within/stack:flex group-hover/stack:flex"
        >
          {people.map((person) => (
            <span key={person.personId} className="flex items-center gap-1.5 px-0.5 py-0.5">
              <IdentityAvatar
                personId={person.personId}
                username={person.username}
                name={person.name}
                size="micro"
              />
              <span className="truncate text-foreground">
                {person.firstChannel
                  ? `${person.username}@${person.firstChannel}`
                  : person.username}
              </span>
            </span>
          ))}
        </span>
      ) : null}
    </span>
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
