import type { SourceRef, ThreadParticipantSummary } from "@t3tools/contracts";
import { IdentityUsername, PersonId } from "@t3tools/contracts";
import { enrichThreadAttribution } from "@t3tools/shared/sourceAttribution";

import { readIdentityMapPeopleFromEnv } from "./IdentityService.ts";

/**
 * Re-resolve Discord/GitHub/Jira actors on stored origin stamps.
 * Threads created while the identity map was empty (or before sourceHint)
 * keep `actor.platformId` without personId; Mine then treats them as ours.
 */
export function applyStoredThreadAttribution(input: {
  readonly originSource?: SourceRef | null | undefined;
  readonly participantSummaries?: ReadonlyArray<ThreadParticipantSummary> | null | undefined;
  readonly createdAt: string;
  readonly messages?:
    | ReadonlyArray<{
        readonly role: string;
        readonly createdAt: string;
        readonly text?: string | undefined;
        readonly source?: SourceRef | undefined;
      }>
    | undefined;
}): {
  readonly originSource?: SourceRef;
  readonly participantSummaries?: ReadonlyArray<ThreadParticipantSummary>;
} {
  const people = readIdentityMapPeopleFromEnv();
  if (people.length === 0) {
    return {
      ...(input.originSource !== null && input.originSource !== undefined
        ? { originSource: input.originSource }
        : {}),
      ...(input.participantSummaries !== null &&
      input.participantSummaries !== undefined &&
      input.participantSummaries.length > 0
        ? { participantSummaries: input.participantSummaries }
        : {}),
    };
  }

  const enriched = enrichThreadAttribution({
    originSource: input.originSource ?? null,
    participantSummaries: input.participantSummaries ?? [],
    createdAt: input.createdAt,
    people,
    messages: input.messages ?? [],
  });

  return {
    ...(enriched.originSource !== null && enriched.originSource !== undefined
      ? {
          originSource: {
            ...enriched.originSource,
            ...(enriched.originSource.personId !== undefined
              ? { personId: PersonId.make(enriched.originSource.personId) }
              : {}),
            ...(enriched.originSource.username !== undefined
              ? { username: IdentityUsername.make(enriched.originSource.username) }
              : {}),
          } as SourceRef,
        }
      : {}),
    ...(enriched.participantSummaries.length > 0
      ? {
          participantSummaries: enriched.participantSummaries.map((entry) => ({
            ...entry,
            personId: PersonId.make(entry.personId),
            username: IdentityUsername.make(entry.username),
          })) as ReadonlyArray<ThreadParticipantSummary>,
        }
      : {}),
  };
}
