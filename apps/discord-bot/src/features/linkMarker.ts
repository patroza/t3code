/**
 * Machine-readable line that ties a Discord thread to a T3 thread.
 *
 * The Teams gateway opens group-chat Discord threads over REST and posts this line once.
 * The guest Discord bot shares the bot token, so it sees that message as its own and adopts
 * the thread from it. That keeps Discord output in one process.
 */
export interface OmegentLinkMarker {
  readonly t3ThreadId: string;
  readonly projectShortName: string;
  readonly sourceKind: "discord" | "teams";
  readonly sourceThreadId: string;
}

const MARKER_LINE = /^-# omegent-link t3:(\S+) project:(\S+) source:(discord|teams):(\S+)\s*$/mu;

/** Discord small-text line, so people see it but it does not clutter the thread. */
export function formatOmegentLinkMarker(marker: OmegentLinkMarker): string {
  return `-# omegent-link t3:${marker.t3ThreadId} project:${marker.projectShortName} source:${marker.sourceKind}:${marker.sourceThreadId}`;
}

export function parseOmegentLinkMarker(content: string): OmegentLinkMarker | null {
  const match = MARKER_LINE.exec(content);
  if (match === null) return null;
  return {
    t3ThreadId: match[1]!,
    projectShortName: match[2]!,
    sourceKind: match[3] as "discord" | "teams",
    sourceThreadId: match[4]!,
  };
}
