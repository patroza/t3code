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
  readonly people: ReadonlyArray<IdentityMapPerson>;
}): string {
  const personId = input.source?.personId;
  if (personId === undefined) return input.message;
  const person = findPersonByPersonId(input.people, personId);
  if (person === null) return input.message;
  const trailer = formatCoAuthoredByTrailer(person);
  if (trailer === null) return input.message;
  const trailerBody = trailer.replace(/^Co-authored-by:\s*/iu, "").trim();
  // Discord's existing turn context uses the compact `cab: Name <email>` form.
  // Treat either representation as already attributed while old/new clients coexist.
  if (input.message.toLowerCase().includes(trailerBody.toLowerCase())) return input.message;

  return `${input.message}\n\n<identity_attribution>\nThe server identity map attributes this turn to ${person.username}. Every git commit created for this work must include this exact trailer after a blank line:\n${trailer}\nKeep the environment's default author and committer.\n</identity_attribution>`;
}
