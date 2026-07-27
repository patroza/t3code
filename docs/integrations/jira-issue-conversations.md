# RFC: Jira issue conversations (mentions + replies)

**Status:** foundation (webhook intake + parsing + bridge skeleton)
**Scope:** Jira Cloud issue comments that mention the T3 bot, bridged to an existing T3 thread

## Summary

An authorized Jira user can **@mention** the configured bot identity in an issue comment (or a reply
in a comment thread when Jira supplies a parent) and continue a T3 thread that is already linked to
that issue key.

The Jira entry point is **lookup-only** for worktrees/projects: it does **not** create projects,
clone repositories, or invent checkouts. Thread resolution uses the **server-native work-item
store** (`thread-work-items.json` under the server state dir) keyed by Jira issue. Discord is **not**
required — Discord links are only an optional migration/import source. If no unique live match
exists, the complete Jira reply is exactly:

```text
not yet linked.
```

Agent-side Jira read/write for general tooling remains the shared Jira MCP (`mcp-atlassian`). This
bridge only owns **inbound webhooks** and **outbound response comments** for mention turns.

## User experience

| Surface       | Webhook event     | Trigger                                        | Where T3 replies  |
| ------------- | ----------------- | ---------------------------------------------- | ----------------- |
| Issue comment | `comment_created` | Explicit configured mention + prompt           | New issue comment |
| Comment reply | `comment_created` | Mention in a comment with `parent` (when set)  | New issue comment |
| Comment edit  | `comment_updated` | Edited comment still contains mention + prompt | New issue comment |

A turn starts only when a non-bot author writes an explicit configured mention followed by a prompt:

```text
@omegent investigate why packing fails on SA-402
```

Mentions are recognized in:

1. Plain / wiki-ish text (`@handle`, `[~accountId:…]`, `[~username]`)
2. Atlassian Document Format (ADF) `mention` nodes (`attrs.id` / `attrs.text`)

Bot-authored comments and mention-free comments are ignored.

**Edits:** `comment_updated` re-dispatches when the edited body still mentions the bot and has a
prompt. Delivery ids include the comment `updated` timestamp (or a prompt fingerprint) so the same
edit is not double-run, but a later edit starts a new turn. The agent prompt notes that the user
edited the comment and treats the new text as authoritative.

## Link definition

An issue is linked when **exactly one** T3 thread lists the issue key in the server
`ThreadWorkItemStore` (`stateDir/thread-work-items.json`).

How associations get there:

1. **Jira webhook** — on a successful resolve/dispatch, the issue key is appended for that thread
2. **GitHub webhook** — PR URLs are recorded the same way (shared store)
3. **Discord import** — optional one-shot/fallback import from Discord bot `links.json`
   (`T3CODE_JIRA_DISCORD_LINKS_PATH`) when the server store has no match yet
4. **Future** — authenticated API / web UI / agent tools to attach work items without Discord

Fail closed when:

- Zero threads match the issue key
- More than one thread matches
- The matched T3 thread no longer exists

## Architecture

```text
Jira Cloud comment_created | comment_updated webhook
        |
        v
POST /api/jira/webhook
  shared-secret verification
  payload validation
  delivery-id dedupe (created: comment id; updated: comment id + updated-at)
        |
        v
JiraIssueBridge
  project allowlist
  parse mention + prompt (+ optional parent comment id)
  resolve unique T3 thread via ThreadWorkItemStore
    (optional Discord links.json import if still unlinked)
  dispatch orchestration turn
  poll projection snapshot
        |
        v
Jira REST comment create (markdown → ADF or wiki)
```

Work-item associations live in:

```text
${T3CODE stateDir}/thread-work-items.json
```

## Configuration

| Variable                         | Required | Default | Purpose                                                          |
| -------------------------------- | -------- | ------- | ---------------------------------------------------------------- |
| `T3CODE_JIRA_WEBHOOK_SECRET`     | yes\*    | —       | Shared secret for inbound webhook auth                           |
| `T3CODE_JIRA_MENTION`            | yes\*    | —       | Bot handle / display name / accountId to match                   |
| `T3CODE_JIRA_URL`                | yes\*    | —       | Site or gateway base (`…atlassian.net` or `…/ex/jira/{cloudId}`) |
| `T3CODE_JIRA_USERNAME`           | yes\*    | —       | Service account email for REST replies                           |
| `T3CODE_JIRA_API_TOKEN`          | yes\*    | —       | API token (Basic or Bearer per deployment)                       |
| `T3CODE_JIRA_ALLOWED_PROJECTS`   | no       | empty   | Comma-separated project keys; empty = all                        |
| `T3CODE_JIRA_DISCORD_LINKS_PATH` | no       | —       | Path to Discord bot `links.json` for issue→thread                |
| `T3CODE_JIRA_TURN_TIMEOUT_MS`    | no       | 30m     | Max wait for turn completion before timeout comment              |
| `T3CODE_JIRA_AUTH_MODE`          | no       | `basic` | `basic` (email+token) or `bearer` (scoped token)                 |

\*When any required value is missing, the integration is **disabled** (webhook returns 404).

## Security

- Require a shared secret on every delivery (`Authorization: Bearer …` or `X-T3-Webhook-Secret`).
- Cap body size at 1 MiB.
- Ignore events that are not `comment_created`.
- Allowlist projects when configured.
- Do not put secrets in prompts, delivery logs, or git.
- Prefer the free Atlassian **service account** for REST replies (see
  [atlassian-service-accounts](./atlassian-service-accounts.md) when present on the branch).

## Outbound comments

Responses are posted as issue comments authored by the service account. Prefer Markdown converted
to a minimal ADF document for API v3. Do not @-spam watchers unless the agent explicitly mentions
users.

## Testing checklist

1. Unit: mention extraction for plain text, wiki, and ADF; parent comment id; bot/self skip.
2. Unit: webhook secret acceptance / rejection; project allowlist.
3. Unit: delivery dedupe on redelivery of the same comment id.
4. Integration (manual): register a Jira webhook or Automation rule → `POST /api/jira/webhook`
   with the shared secret; mention the bot on a linked issue; confirm a reply comment.

## Non-goals (this foundation)

- Creating worktrees or projects from Jira
- Full comment-edit re-routing
- Confluence page mentions
- Jira Service Management customer portal public/internal split (beyond posting internal comments later)
- Real-time streaming of intermediate assistant text into Jira (final answer only)
