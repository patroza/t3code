import type { ThreadParticipantSummary } from "@t3tools/contracts";

export function participantDisplayLabel(person: ThreadParticipantSummary): string {
  const channels =
    person.channels ?? (person.firstChannel === undefined ? [] : [person.firstChannel]);
  return channels.length === 0 ? person.username : `${person.username}@${channels.join(",")}`;
}
