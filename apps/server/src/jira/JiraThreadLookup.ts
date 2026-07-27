/**
 * Resolve a Jira issue key from a Discord bot links.json payload.
 *
 * Preferred resolution is the server-native {@link ThreadWorkItemStore}. This helper remains
 * for migration/fallback when Discord still holds associations that have not been imported yet.
 */

import type { ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const DiscordThreadLink = Schema.Struct({
  discordThreadId: Schema.optional(Schema.String),
  t3ThreadId: Schema.String,
  status: Schema.optional(Schema.String),
  jiraIssueKeys: Schema.optional(Schema.Array(Schema.String)),
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

export function resolveThreadIdForJiraIssue(input: {
  readonly issueKey: string;
  readonly linksJson: string;
}): JiraThreadLookupResult {
  const issueKey = input.issueKey.trim().toUpperCase();
  if (issueKey.length === 0) return { _tag: "unlinked" };

  let links: ReadonlyArray<typeof DiscordThreadLink.Type>;
  try {
    links = decodeLinksFile(input.linksJson).links;
  } catch {
    return { _tag: "unlinked" };
  }

  const matches = new Set<string>();
  for (const link of links) {
    if (link.status !== undefined && link.status !== "active") continue;
    const keys = link.jiraIssueKeys ?? [];
    const hit = keys.some((key) => key.trim().toUpperCase() === issueKey);
    if (!hit) continue;
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
