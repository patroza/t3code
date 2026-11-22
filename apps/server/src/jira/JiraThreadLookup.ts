/**
 * Discord destinations for untrusted Jira context notes come from the Discord bot's
 * links.json (apps/discord-bot/src/store/ThreadLinkStore.ts, v2 document). These helpers
 * do not choose the T3 thread for a Jira turn: that is the upstream thread issue link.
 */

import * as Schema from "effect/Schema";

// The subset of the bot's ThreadLink this module reads; unknown keys are ignored.
const DiscordThreadLink = Schema.Struct({
  sourceKind: Schema.optional(Schema.String),
  discordThreadId: Schema.optional(Schema.String),
  t3ThreadId: Schema.String,
  channelId: Schema.optional(Schema.String),
  guildId: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  jiraIssueKeys: Schema.optional(Schema.Array(Schema.String)),
  linkedJiraIssueKeys: Schema.optional(Schema.Array(Schema.String)),
  backfillJiraIssueKeys: Schema.optional(Schema.Array(Schema.String)),
});

const DiscordLinksFile = Schema.Struct({
  version: Schema.optional(Schema.Number),
  links: Schema.Array(DiscordThreadLink),
});

const decodeLinksFile = Schema.decodeUnknownSync(Schema.fromJsonString(DiscordLinksFile));

export type JiraDiscordLinkLookupResult =
  | { readonly _tag: "unlinked" }
  | {
      readonly _tag: "ambiguous";
      readonly discordThreadIds: ReadonlyArray<string>;
    }
  | {
      readonly _tag: "linked";
      readonly discordThreadId: string;
      readonly t3ThreadId: string | null;
      readonly channelId: string | null;
      readonly guildId: string | null;
    };

function decodeLinks(linksJson: string): ReadonlyArray<typeof DiscordThreadLink.Type> {
  try {
    return decodeLinksFile(linksJson).links;
  } catch {
    return [];
  }
}

/** Keys used to find the Discord channel for a context note. Not work-item identity. */
function linkIdentityKeys(link: typeof DiscordThreadLink.Type): ReadonlyArray<string> {
  if (link.linkedJiraIssueKeys !== undefined) return link.linkedJiraIssueKeys;
  return link.jiraIssueKeys ?? [];
}

function activeLinksWithIssue(
  linksJson: string,
  issueKeyRaw: string,
): ReadonlyArray<typeof DiscordThreadLink.Type> {
  const issueKey = issueKeyRaw.trim().toUpperCase();
  if (issueKey.length === 0) return [];

  return decodeLinks(linksJson).filter((link) => {
    if (link.status !== undefined && link.status !== "active") return false;
    // Teams conversations share the store but have no Discord thread to post into.
    if ((link.sourceKind ?? "discord") !== "discord") return false;
    return linkIdentityKeys(link).some((key) => key.trim().toUpperCase() === issueKey);
  });
}

/**
 * Resolve the Discord thread to post untrusted Jira context into.
 * Requires a unique active links.json row with both the issue key and a discordThreadId.
 */
export function resolveDiscordLinkForJiraIssue(input: {
  readonly issueKey: string;
  readonly linksJson: string;
}): JiraDiscordLinkLookupResult {
  const withDiscord = activeLinksWithIssue(input.linksJson, input.issueKey).filter(
    (link) => (link.discordThreadId?.trim().length ?? 0) > 0,
  );
  if (withDiscord.length === 0) return { _tag: "unlinked" };
  if (withDiscord.length > 1) {
    return {
      _tag: "ambiguous",
      discordThreadIds: withDiscord.map((link) => link.discordThreadId!.trim()),
    };
  }
  const only = withDiscord[0]!;
  return {
    _tag: "linked",
    discordThreadId: only.discordThreadId!.trim(),
    t3ThreadId: only.t3ThreadId.trim() || null,
    channelId: only.channelId?.trim() || null,
    guildId: only.guildId?.trim() || null,
  };
}
