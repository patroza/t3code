import { classifyTeamsAgentAccess, type PersonIdentity } from "../identityMap.ts";
import { teamsMessageText, type TeamsMessage } from "./presentation.ts";

/** The selected message author is context, distinct from the authorized requester. */
export function teamsMessageActionPrompt(input: {
  readonly message: TeamsMessage;
  readonly requester: PersonIdentity;
  readonly people: ReadonlyArray<PersonIdentity>;
  readonly instructions: string;
}): string {
  const author = input.message.from?.user;
  const access = classifyTeamsAgentAccess({ people: input.people, userId: author?.id });
  const authorName = access.allowed ? access.person.name : "Unknown";
  return [
    "Investigate the following Microsoft Teams message.",
    `Requested by: ${input.requester.name}`,
    `Selected message author: ${authorName}${author?.id ? ` (Teams ID: ${author.id})` : ""}`,
    !access.allowed && author?.displayName
      ? `Unmapped Teams display name: ${author.displayName}`
      : null,
    `Selected message ID: ${input.message.id}`,
    input.message.replyToId ? `Reply to message ID: ${input.message.replyToId}` : null,
    teamsMessageText(input.message),
    input.instructions.length === 0 ? null : `Additional instructions: ${input.instructions}`,
  ]
    .filter((line): line is string => line !== null && line.length > 0)
    .join("\n\n");
}
