/**
 * Server-side SourceRef helpers and thread participant denormalization.
 *
 * Clients never invent personId/username — those come from session claim or
 * platform map resolution. Channel is derived from auth client device type
 * (or an explicit SourceChannel for integrations).
 *
 * See docs/architecture/source-and-identity.md
 */
import type { AuthClientMetadataDeviceType, SourceChannel } from "@t3tools/contracts";

export type SourceRefLike = {
  readonly channel: SourceChannel;
  readonly personId?: string | undefined;
  readonly username?: string | undefined;
  readonly location?: {
    readonly guildId?: string | undefined;
    readonly channelId?: string | undefined;
    readonly threadId?: string | undefined;
    readonly owner?: string | undefined;
    readonly repo?: string | undefined;
    readonly number?: number | undefined;
    readonly kind?: "pr" | "issue" | undefined;
    readonly projectKey?: string | undefined;
    readonly issueKey?: string | undefined;
  };
  readonly actor?: {
    readonly platformId?: string | undefined;
    readonly displayName?: string | undefined;
  };
};

/** Map auth client deviceType → SourceChannel. */
export function sourceChannelFromDeviceType(
  deviceType: AuthClientMetadataDeviceType | undefined | null,
): SourceChannel {
  switch (deviceType) {
    case "desktop":
      return "desktop";
    case "mobile":
    case "tablet":
      return "mobile";
    case "bot":
      return "bot";
    case "unknown":
    case undefined:
    case null:
      return "unknown";
    default: {
      const _exhaustive: never = deviceType;
      void _exhaustive;
      return "unknown";
    }
  }
}

/**
 * Prefer an explicit channel (ClientSourceHint / integration) when present;
 * otherwise derive from session deviceType. Web is not a deviceType today —
 * browser clients often report desktop; accept explicit "web" when hinted.
 */
export function resolveSourceChannel(input: {
  readonly deviceType?: AuthClientMetadataDeviceType | null | undefined;
  readonly channelHint?: SourceChannel | null | undefined;
}): SourceChannel {
  if (input.channelHint !== undefined && input.channelHint !== null) {
    return input.channelHint;
  }
  return sourceChannelFromDeviceType(input.deviceType);
}

export function buildSourceRefFromClaim(input: {
  readonly personId: string;
  readonly username: string;
  readonly channel: SourceChannel;
  readonly location?: SourceRefLike["location"];
  readonly actor?: SourceRefLike["actor"];
}): SourceRefLike {
  return {
    channel: input.channel,
    personId: input.personId,
    username: input.username,
    ...(input.location !== undefined ? { location: input.location } : {}),
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
  };
}

export type ParticipantSummaryLike = {
  readonly personId: string;
  readonly username: string;
  readonly name?: string | undefined;
  readonly firstChannel?: SourceChannel | undefined;
  readonly channels?: ReadonlyArray<SourceChannel> | undefined;
  readonly firstParticipatedAt: string;
};

/**
 * Merge a user message SourceRef into ordered participant summaries.
 * Origin person stays first when already present; new people append by
 * first-participation time (caller passes chronological events).
 */
export function mergeParticipantSummaries(input: {
  readonly existing: ReadonlyArray<ParticipantSummaryLike>;
  readonly source: {
    readonly personId?: string | undefined;
    readonly username?: string | undefined;
    readonly channel: SourceChannel;
    readonly name?: string | undefined;
  };
  readonly participatedAt: string;
  readonly originPersonId?: string | null | undefined;
}): ReadonlyArray<ParticipantSummaryLike> {
  const personId = input.source.personId;
  if (personId === undefined || personId === null || personId.length === 0) {
    return input.existing;
  }
  const username = input.source.username;
  if (username === undefined || username === null || username.length === 0) {
    return input.existing;
  }

  const existingIndex = input.existing.findIndex((entry) => entry.personId === personId);
  if (existingIndex !== -1) {
    const existingEntry = input.existing[existingIndex]!;
    const channels =
      existingEntry.channels ??
      (existingEntry.firstChannel === undefined ? [] : [existingEntry.firstChannel]);
    if (channels.includes(input.source.channel)) {
      return input.existing;
    }
    return input.existing.map((entry, index) =>
      index === existingIndex
        ? {
            ...entry,
            channels: [...channels, input.source.channel],
          }
        : entry,
    );
  }

  const nextEntry: ParticipantSummaryLike = {
    personId,
    username,
    ...(input.source.name !== undefined ? { name: input.source.name } : {}),
    firstChannel: input.source.channel,
    channels: [input.source.channel],
    firstParticipatedAt: input.participatedAt,
  };

  const originId = input.originPersonId ?? null;
  if (originId !== null && personId === originId) {
    return [nextEntry, ...input.existing];
  }

  // Keep origin lead if present, then append by first-seen order.
  if (originId !== null) {
    const origin = input.existing.find((entry) => entry.personId === originId);
    const rest = input.existing.filter((entry) => entry.personId !== originId);
    if (origin !== undefined) {
      return [origin, ...rest, nextEntry];
    }
  }

  return [...input.existing, nextEntry];
}

/** First user-message SourceRef becomes origin when none set yet. */
export function nextOriginSource(input: {
  readonly current: SourceRefLike | null | undefined;
  readonly messageSource: SourceRefLike | undefined;
  readonly role: string;
}): SourceRefLike | null | undefined {
  if (input.role !== "user") return input.current;
  if (input.current !== undefined && input.current !== null) return input.current;
  return input.messageSource ?? input.current ?? null;
}
