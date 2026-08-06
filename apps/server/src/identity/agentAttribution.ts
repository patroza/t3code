import type { SourceRef } from "@t3tools/contracts";
import {
  findPersonByPersonId,
  formatCoAuthoredByTrailer,
  type IdentityMapPerson,
} from "@t3tools/shared/identityMap";

/** Add trusted commit attribution to an agent turn, regardless of its channel. */
export function withAgentIdentityAttribution(input: {
  readonly message: string;
  readonly source?: SourceRef | undefined;
  readonly additionalSources?: ReadonlyArray<SourceRef | null | undefined> | undefined;
  readonly people: ReadonlyArray<IdentityMapPerson>;
}): string {
  const sources = [...(input.additionalSources ?? []), input.source];
  const seenPeople = new Set<string>();
  const attributions: Array<{ readonly username: string; readonly trailer: string }> = [];
  for (const source of sources) {
    const personId = source?.personId;
    if (personId === undefined || seenPeople.has(personId)) continue;
    seenPeople.add(personId);
    const person = findPersonByPersonId(input.people, personId);
    if (person === null) continue;
    const trailer = formatCoAuthoredByTrailer(person);
    if (trailer === null) continue;
    const trailerBody = trailer.replace(/^Co-authored-by:\s*/iu, "").trim();
    // Discord's legacy context uses the compact `cab: Name <email>` form.
    if (input.message.toLowerCase().includes(trailerBody.toLowerCase())) continue;
    attributions.push({ username: person.username, trailer });
  }
  if (attributions.length === 0) return input.message;

  return `${input.message}\n\n<identity_attribution>\nThe server identity map attributes this work to ${attributions.map(({ username }) => username).join(", ")}. Every git commit created for this work must include each exact trailer below after a blank line:\n${attributions.map(({ trailer }) => trailer).join("\n")}\nKeep the environment's default author and committer.\n</identity_attribution>`;
}
