export interface TeamsMessageAuthor {
  readonly id?: string | undefined;
  readonly displayName?: string | undefined;
}

export interface TeamsMessage {
  readonly id: string;
  readonly replyToId?: string | null | undefined;
  readonly createdDateTime?: string | undefined;
  readonly subject?: string | null | undefined;
  readonly summary?: string | null | undefined;
  readonly webUrl?: string | undefined;
  readonly messageType?: string | undefined;
  readonly from?:
    | {
        readonly user?: TeamsMessageAuthor | null | undefined;
        readonly application?: { readonly displayName?: string | undefined } | null | undefined;
      }
    | null
    | undefined;
  readonly body?:
    | {
        readonly contentType?: string | undefined;
        readonly content?: string | null | undefined;
      }
    | null
    | undefined;
  readonly attachments?:
    | ReadonlyArray<{
        readonly id?: string | undefined;
        readonly contentType?: string | undefined;
        readonly contentUrl?: string | undefined;
        readonly name?: string | undefined;
        readonly thumbnailUrl?: string | undefined;
      }>
    | undefined;
  readonly reactions?:
    | ReadonlyArray<{
        readonly reactionType?: string | undefined;
        readonly displayName?: string | undefined;
        readonly user?:
          | {
              readonly user?:
                | {
                    readonly id?: string | undefined;
                    readonly displayName?: string | undefined;
                  }
                | null
                | undefined;
            }
          | null
          | undefined;
      }>
    | undefined;
  readonly mentions?:
    | ReadonlyArray<{
        readonly mentionText?: string | undefined;
        readonly mentioned?:
          | {
              readonly user?: TeamsMessageAuthor | null | undefined;
              readonly application?:
                | { readonly displayName?: string | undefined }
                | null
                | undefined;
            }
          | null
          | undefined;
      }>
    | undefined;
}

const DEFAULT_GERMAN_PROBLEM_KEYWORDS = [
  "fehler",
  "störung",
  "stoerung",
  "problem",
  "kaputt",
  "funktioniert nicht",
  "geht nicht",
  "ausfall",
  "dringend",
  "hilfe",
  "betroffen",
  "unterbrochen",
  "broken",
  "incident",
] as const;

const GERMAN_MARKERS = [
  "der",
  "die",
  "das",
  "nicht",
  "bitte",
  "kann",
  "können",
  "koennen",
  "seit",
  "heute",
  "gestern",
  "kunde",
  "umgebung",
  "produktion",
] as const;

export function teamsMessageText(message: TeamsMessage): string {
  const content = message.body?.content ?? "";
  return decodeHtmlEntities(
    content
      .replace(/<style[\s\S]*?<\/style>/giu, " ")
      .replace(/<script[\s\S]*?<\/script>/giu, " ")
      .replace(/<[^>]+>/gu, " ")
      .replace(/\s+/gu, " ")
      .trim(),
  )
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizedText(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replaceAll("&nbsp;", " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

export function rootTeamsMessageId(message: TeamsMessage): string {
  return message.replyToId ?? message.id;
}

export function teamsMessageTimestamp(message: TeamsMessage): string {
  return message.createdDateTime ?? "";
}

export function isHumanTeamsMessage(message: TeamsMessage): boolean {
  if (message.messageType && message.messageType !== "message") return false;
  if (message.from?.application) return false;
  return teamsMessageText(message).trim().length > 0;
}

export function mentionsTeamsBot(message: TeamsMessage, displayName: string | undefined): boolean {
  const normalizedDisplayName = normalizedText(displayName);
  if (
    normalizedDisplayName.length > 0 &&
    message.mentions?.some((mention) => {
      const names = [
        mention.mentionText,
        mention.mentioned?.application?.displayName,
        mention.mentioned?.user?.displayName,
      ]
        .filter((value): value is string => typeof value === "string")
        .map((value) => normalizedText(value));
      return names.includes(normalizedDisplayName);
    })
  ) {
    return true;
  }

  const text = normalizedText(teamsMessageText(message));
  return normalizedDisplayName.length > 0 ? text.includes(normalizedDisplayName) : false;
}

export function looksLikeGermanProblemReport(input: {
  readonly message: TeamsMessage;
  readonly companyKeywords: ReadonlyArray<string>;
  readonly environmentKeywords: ReadonlyArray<string>;
  readonly problemKeywords?: ReadonlyArray<string> | undefined;
}): boolean {
  const text = teamsMessageText(input.message).toLowerCase();
  if (text.length === 0) return false;

  const germanMarkerHits = GERMAN_MARKERS.filter((marker) => text.includes(marker)).length;
  const umlautHint = /[äöüß]/iu.test(text);
  const germanish = umlautHint || germanMarkerHits >= 2;
  if (!germanish) return false;

  const companyHit = input.companyKeywords.some((keyword) => text.includes(keyword.toLowerCase()));
  const environmentHit = input.environmentKeywords.some((keyword) =>
    text.includes(keyword.toLowerCase()),
  );
  const problemHit = [...DEFAULT_GERMAN_PROBLEM_KEYWORDS, ...(input.problemKeywords ?? [])].some(
    (keyword) => text.includes(keyword.toLowerCase()),
  );

  return problemHit && (companyHit || environmentHit);
}

export function isAllowlistedInternalUser(
  message: TeamsMessage,
  allowlistedUserIds: ReadonlyArray<string> | undefined,
): boolean {
  const authorId = normalizedText(message.from?.user?.id);
  return (
    authorId.length > 0 && (allowlistedUserIds ?? []).some((id) => normalizedText(id) === authorId)
  );
}

export function hasAllowlistedReaction(input: {
  readonly message: TeamsMessage;
  readonly allowlistedUserIds?: ReadonlyArray<string> | undefined;
  readonly reactionTriggerTypes?: ReadonlyArray<string> | undefined;
}): boolean {
  if ((input.reactionTriggerTypes ?? []).length === 0) return false;

  return (input.message.reactions ?? []).some((reaction) => {
    const reactionType = normalizedText(reaction.reactionType);
    const reactingUserId = normalizedText(reaction.user?.user?.id);
    if (reactionType.length === 0 || reactingUserId.length === 0) return false;
    const typeMatch = (input.reactionTriggerTypes ?? []).some(
      (trigger) => normalizedText(trigger) === reactionType,
    );
    const userMatch = (input.allowlistedUserIds ?? []).some(
      (userId) => normalizedText(userId) === reactingUserId,
    );
    return typeMatch && userMatch;
  });
}

export function hasInternalTagTrigger(input: {
  readonly message: TeamsMessage;
  readonly allowlistedUserIds?: ReadonlyArray<string> | undefined;
  readonly messageTagTriggers?: ReadonlyArray<string> | undefined;
}): boolean {
  if (!isAllowlistedInternalUser(input.message, input.allowlistedUserIds)) return false;
  const text = normalizedText(teamsMessageText(input.message));
  return (input.messageTagTriggers ?? []).some((tag) => {
    const normalizedTag = normalizedText(tag);
    return normalizedTag.length > 0 && text.includes(normalizedTag);
  });
}

export function buildTeamsIncidentTitle(input: {
  readonly company: string;
  readonly environment: string;
  readonly message: TeamsMessage;
}): string {
  const text = teamsMessageText(input.message).replace(/\s+/gu, " ").trim();
  const summary = text.length > 96 ? `${text.slice(0, 95).trimEnd()}…` : text;
  return `${input.company} ${input.environment}: ${summary || "Teams incident"}`;
}

export function buildTeamsSeedMessage(input: {
  readonly company: string;
  readonly environment: string;
  readonly channelName: string;
  readonly message: TeamsMessage;
  readonly reason: "mention" | "german-problem" | "allowlisted-reaction" | "internal-tag";
}): string {
  const author = input.message.from?.user?.displayName ?? "unknown";
  const text = teamsMessageText(input.message);
  const triggerLabel =
    input.reason === "mention"
      ? "@mention"
      : input.reason === "german-problem"
        ? "German problem report"
        : input.reason === "allowlisted-reaction"
          ? "allowlisted reaction"
          : "allowlisted internal tag";
  return [
    `**Teams intake** from **${input.channelName}**`,
    `Company: **${input.company}**`,
    `Environment: **${input.environment}**`,
    `Trigger: ${triggerLabel}`,
    `Author: ${author}`,
    input.message.webUrl ? `Source: ${input.message.webUrl}` : null,
    "",
    text,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

export function buildTeamsPrompt(input: {
  readonly channelName: string;
  readonly company: string;
  readonly environment: string;
  readonly projectShortName: string;
  readonly reason: "mention" | "german-problem" | "allowlisted-reaction" | "internal-tag";
  readonly message: TeamsMessage;
  readonly triggerMessage?: TeamsMessage | undefined;
  readonly history?: ReadonlyArray<TeamsMessage> | undefined;
}): string {
  const text = teamsMessageText(input.message);
  const author = input.message.from?.user?.displayName ?? "unknown";
  const triggerText =
    input.reason === "mention"
      ? "explicit @mention"
      : input.reason === "german-problem"
        ? "German problem report detection"
        : input.reason === "allowlisted-reaction"
          ? "allowlisted reaction trigger"
          : "allowlisted internal tag trigger";
  const history = (input.history ?? [])
    .map((message) => {
      const entryAuthor = message.from?.user?.displayName ?? "unknown";
      const when = message.createdDateTime ?? "unknown time";
      const body = teamsMessageText(message);
      return `[${when}] ${entryAuthor}: ${body}`;
    })
    .join("\n");

  return `## Microsoft Teams intake

Project short name: ${input.projectShortName}
Company: ${input.company}
Environment: ${input.environment}
Teams channel: ${input.channelName}
Trigger: ${triggerText}
Author: ${author}
Message id: ${input.message.id}
${input.message.replyToId ? `Reply to: ${input.message.replyToId}` : "Root message: yes"}
${input.message.webUrl ? `Source URL: ${input.message.webUrl}` : "Source URL: unavailable"}

${
  input.triggerMessage && input.triggerMessage.id !== input.message.id
    ? `Trigger message id: ${input.triggerMessage.id}
Trigger message author: ${input.triggerMessage.from?.user?.displayName ?? "unknown"}
Trigger message text: ${teamsMessageText(input.triggerMessage)}`
    : ""
}

## Original Teams message
${text}

## Recent channel history
${history.length > 0 ? history : "(no recent preceding messages in scope)"}

## Task
Treat this as an incident intake from Teams. Infer the likely user problem from the German text, investigate it, and post the analysis into this Discord thread.
If details are ambiguous, say so explicitly instead of inventing specifics.`;
}
