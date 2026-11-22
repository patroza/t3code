/**
 * Discord destinations for untrusted Jira context notes come from links.json.
 * These helpers do not choose the T3 thread for a Jira or Discord turn. Work-item
 * identity is only what a Jira or GitHub webhook recorded.
 */

import type { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const DiscordThreadLink = Schema.Struct({
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

export type JiraThreadLookupResult =
  | { readonly _tag: "unlinked" }
  | { readonly _tag: "ambiguous"; readonly threadIds: ReadonlyArray<ThreadId> }
  | { readonly _tag: "linked"; readonly threadId: ThreadId };

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
    return linkIdentityKeys(link).some((key) => key.trim().toUpperCase() === issueKey);
  });
}

/** Legacy parse of Discord link rows. Jira resolution does not call this. */
export function resolveThreadIdForJiraIssue(input: {
  readonly issueKey: string;
  readonly linksJson: string;
}): JiraThreadLookupResult {
  const matches = new Set<string>();
  for (const link of activeLinksWithIssue(input.linksJson, input.issueKey)) {
    const threadId = link.t3ThreadId.trim();
    if (threadId.length > 0) matches.add(threadId);
  }

  if (matches.size === 0) return { _tag: "unlinked" };
  if (matches.size > 1) {
    return {
      _tag: "ambiguous",
      threadIds: [...matches] as ThreadId[],
    };
  }
  const [only] = matches;
  return { _tag: "linked", threadId: only as ThreadId };
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
