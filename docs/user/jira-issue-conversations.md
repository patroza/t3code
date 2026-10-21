# RFC: Jira issue conversations (mentions + replies)

**Status:** foundation (webhook intake + parsing + bridge skeleton)
**Scope:** Jira Cloud issue comments that mention the T3 bot, bridged to an existing T3 thread

## Summary

An authorized Jira user can **@mention** the configured bot identity in an issue comment (or a reply
in a comment thread when Jira supplies a parent) and continue a T3 thread that is already linked to
that issue key.

Thread resolution uses the **server-native work-item store** (`thread-work-items.json` under the
server state dir) keyed by Jira issue (**join-or-create**):

1. **Exactly one** store hit → continue that thread (Discord import is a migration fallback only).
2. **Multiple** hits → fail closed with an ambiguous message (never guess).
3. **Zero** hits → **auto-create** a T3 thread on a **new git worktree** (never the project main
   checkout), attach the issue key, and run the turn. Project pick order:
   `T3CODE_JIRA_PROJECT_MAP` for the Jira project key (e.g. `SA`) →
   `T3CODE_JIRA_DEFAULT_PROJECT_ID` → sole shell project when exactly one exists. Disable with
   `T3CODE_JIRA_AUTO_CREATE_THREAD=false`. Base branch: `T3CODE_JIRA_BASE_BRANCH` (default `main`).
   Branch names are key-first (`SA-402-t3-<id>`) so GitHub-for-Jira can auto-link.

Does **not** create projects or clone repositories. New threads always get a dedicated worktree
sibling under the project's worktrees dir (same isolation model as Discord/GitHub create). Later
surfaces join via the same work-item store.

Agent-side Jira read/write for general tooling remains the shared Jira MCP (`mcp-atlassian`). This
bridge only owns **inbound webhooks** and **outbound response comments** for mention turns.

## User experience

| Surface       | Webhook event                            | Trigger                                        | Where T3 replies                                     |
| ------------- | ---------------------------------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Issue comment | `comment_created`                        | Explicit configured mention + prompt           | Threaded **reply** under the mention (`parentId`)    |
| Comment reply | `comment_created`                        | Mention in a comment with `parent` (when set)  | Threaded **reply** under the same thread root        |
| Comment edit  | `comment_updated`                        | Edited comment still contains mention + prompt | Threaded **reply** under the edited comment’s thread |
| Assignment    | `issue_assigned` or `jira:issue_updated` | Assignee changes to the configured bot         | Top-level issue comment                              |

A turn starts only when a non-bot author writes an explicit configured mention followed by a prompt:

```text
@omegent investigate why packing fails on SA-402
```

Mentions are recognized in:

1. Plain / wiki-ish text (`@handle`, `[~accountId:…]`, `[~username]`)
2. Atlassian Document Format (ADF) `mention` nodes (`attrs.id` / `attrs.text`)

Bot-authored comments and mention-free comments are ignored.

**Assignment:** assigning the configured bot (display name or account id) starts a turn with no extra prompt. The agent reads the issue and proposes a fix or implementation, implementing it when the change is clear. The reply is a top-level comment that @-mentions the person who assigned the issue. Assigning someone else, clearing the assignee, or editing the issue while the bot is already assigned does not start a turn. The bot assigning itself is ignored.

Automation can POST the same webhook with:

```json
{
  "webhookEvent": "issue_assigned",
  "user": {
    "accountId": "{{initiator.accountId}}",
    "displayName": "{{initiator.displayName}}"
  },
  "changelog": { "id": "{{changelog.id}}" },
  "issue": {
    "key": "{{issue.key}}",
    "fields": {
      "summary": "{{issue.summary}}",
      "description": "{{issue.description}}",
      "updated": "{{issue.updated}}",
      "project": { "key": "{{issue.project.key}}" },
      "assignee": {
        "accountId": "{{issue.assignee.accountId}}",
        "displayName": "{{issue.assignee.displayName}}"
      }
    }
  }
}
```

`changelog.id` dedupes retries. A later assignment uses a new changelog id and starts another turn. A native `jira:issue_updated` webhook is accepted when its changelog `assignee` item points at the bot.

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
3. **Discord** — does not create work-item identity. The thread-info pin may list Jira
   links, plus bare keys whose project is named in that repository's `t3.json`
   `jiraProjects` (a repository can name more than one). A token that only looks like a
   key is left off. Pin backfill uses the same rule. A later Discord mention does not
   join that conversation. It links to the existing one and adds a button,
   "start a new thread here anyway". Until that button is clicked, the Discord
   thread is not linked and no turn starts. The button starts a separate thread
   here. Mentioning the key in Discord does not retarget the existing conversation.
   On a lookup miss, Discord-only rows are removed from the store.
4. **Future** — authenticated API / web UI / agent tools to attach work items without Discord

Fail closed when:

- Zero threads match the issue key
- More than one thread matches
- The matched T3 thread no longer exists

## Architecture

```text
Jira Cloud comment_created | comment_updated | issue assignment webhook
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
  reply 👀 on the trigger comment so the author can see it was read
  parse mention + prompt (+ optional parent comment id)
  resolve unique T3 thread via ThreadWorkItemStore
    (optional Discord links.json import if still unlinked)
  join-or-create via PROJECT_MAP / DEFAULT_PROJECT_ID / sole project
  dispatch orchestration turn
  poll projection snapshot
        |
        v
Jira REST comment create (markdown → ADF, parentId reply when possible)
```

Work-item associations live in:

```text
${T3CODE stateDir}/thread-work-items.json
```

## Webhook debug log

Every inbound integration webhook writes one NDJSON row under the server state dir:

```text
${T3CODE stateDir}/jira-webhook-debug.ndjson
${T3CODE stateDir}/github-webhook-debug.ndjson
```

Outcomes include `accepted_202`, `ignored_202`, `invalid_400`, `unauthorized_401`,
`project_denied_202` / `repo_denied_202`, `too_large_413`, `missing_delivery_id_400`
(GitHub), and `disabled_404`. Invalid rows store a capped `bodyPreview` plus a `reason`
(`json_parse_failed` is common when Jira Automation injects unescaped newlines into
Custom data JSON).

Retention: **24 hours** (and a hard cap of 5 000 rows per source). Older lines are pruned
on each append and on process start. Best-effort only — append failures never fail the
webhook.

## Configuration

| Variable                         | Required | Default | Purpose                                                           |
| -------------------------------- | -------- | ------- | ----------------------------------------------------------------- |
| `T3CODE_JIRA_WEBHOOK_SECRET`     | yes\*    | —       | Shared secret for inbound webhook auth                            |
| `T3CODE_JIRA_MENTION`            | yes\*    | —       | Bot handle / display name / accountId to match                    |
| `T3CODE_JIRA_URL`                | yes\*    | —       | Site or gateway base (`…atlassian.net` or `…/ex/jira/{cloudId}`)  |
| `T3CODE_JIRA_USERNAME`           | yes\*    | —       | Service account email for REST replies                            |
| `T3CODE_JIRA_API_TOKEN`          | yes\*    | —       | API token (Basic or Bearer per deployment)                        |
| `T3CODE_JIRA_ALLOWED_PROJECTS`   | no       | empty   | Comma-separated project keys; empty = all                         |
| `T3CODE_JIRA_DISCORD_LINKS_PATH` | no       | —       | Path to Discord bot `links.json` for issue→thread                 |
| `T3CODE_JIRA_TURN_TIMEOUT_MS`    | no       | 30m     | Max wait for turn completion before timeout comment               |
| `T3CODE_JIRA_AUTH_MODE`          | no       | `basic` | `basic` (email+token) or `bearer` (scoped token)                  |
| `T3CODE_JIRA_AUTO_CREATE_THREAD` | no       | `true`  | Create a T3 thread when the issue is unlinked                     |
| `T3CODE_JIRA_PROJECT_MAP`        | no       | empty   | Jira key → T3 project map (see below)                             |
| `T3CODE_JIRA_DEFAULT_PROJECT_ID` | no\*     | —       | Fallback project for auto-create (\*or exactly one shell project) |
| `T3CODE_JIRA_ACK_EMOJI_ID`       | no       | `1f440` | Read receipt on the trigger comment (`👀`); empty string disables |
| `T3CODE_JIRA_BOT_ACCOUNT_ID`     | no       | —       | Alias for wiki/ADF `[~accountId:…]` mention matching              |
| `T3CODE_JIRA_CONFLUENCE_PAGES`   | no       | empty   | Where a reply goes when it does not fit in a comment (see below)  |

\*When any required value is missing, the integration is **disabled** (webhook returns 404).

### Project map values

Each map value (and `T3CODE_JIRA_DEFAULT_PROJECT_ID`) may be any of:

1. **T3 project id** (UUID from the shell / `links.json` `projectId`)
2. **Project title** (case-insensitive), e.g. `scanner`
3. **Workspace basename**, e.g. `scanner` for `/var/lib/t3/src/macs/scanner`
4. **Absolute workspace root**, e.g. `/var/lib/t3/src/macs/scanner` (Discord-style paths)

```bash
# Prefer prefix map for multi-project hosts
T3CODE_JIRA_PROJECT_MAP=SA:scanner,CFG:/var/lib/t3/src/macs/configurator

# Optional global fallback (id, title, basename, or full path)
T3CODE_JIRA_DEFAULT_PROJECT_ID=/var/lib/t3/src/macs/scanner
```

### Long replies

Jira comments render Markdown: headings, emphasis, links, lists, tables, quotes, and fenced code
blocks. A GitHub pull request or issue address shows as `repo#123`, and a Jira issue address shows
as its key. Other addresses stay links with the address as the label. A reply that does not fit in
one comment keeps a leading portion in the comment. The rest is filed where you assign it, and the
comment links to that exact section.

```bash
# Jira project : Confluence space / parent page titles
# The leaf page is the issue key, for example SA-516 under scanner/omegent.
T3CODE_JIRA_CONFLUENCE_PAGES=SA:SA/scanner/omegent,CFG:CFG/configurator/omegent
```

The first path segment is the Confluence space. Each later segment is a parent page title, created
when it is missing. Page titles are unique inside a space, so each Jira project needs its own
space entry. Each response is a new heading on the issue page, and the Jira comment links to that
heading.

When this variable is empty, or Confluence rejects the write, the overflow is attached to the
issue as a Markdown file and the comment links to that file.

### Read receipt

On accept, the bridge replies under the triggering comment with eyes (`👀` by default)
so you can see the mention was read before the answer is ready. That reply stays. The answer
follows as another reply when the turn finishes. An empty `T3CODE_JIRA_ACK_EMOJI_ID` skips the
receipt. `1f44d` sends 👍 instead. A failed receipt does not block the turn.

## Bug reports

A Bug created in a configured Jira space is picked up on its own. The Jira webhook has to send Issue created, as well as the comment events it already sends. Configured spaces are the keys in `T3CODE_JIRA_PROJECT_MAP` (for example `SA` and `CFG`). When `T3CODE_JIRA_ALLOWED_PROJECTS` is set, the key has to be in that list too.

The report is public input. It is not a prompt. Nothing in the summary or description is run.

The review runs in a T3 thread. When the analysis is ready, it is posted as a comment on the Jira issue and mentions the mapped team (people who have a Jira account id). A proposed fix is posted the same way and mentions the team again. Those comments are top-level, because a new bug has no triggering comment, and they mention the team rather than the reporter. Nothing from this flow is posted to Discord. A review that stops before an analysis leaves a short note and does not mention the team.

The agent does not comment on the issue itself. The bridge posts those comments.

### Turn it on in Jira

Comment mentions already arrive from Jira Automation as `comment_created` and `comment_updated`. A new bug does not. Add one rule. Leave the comment rules in place, and leave their `webhookEvent` set to `comment_created` or `comment_updated`.

Do this after the server build that contains bug review is deployed. A delivery sent before that build is ignored and is not replayed.

1. Open **Jira settings → System → Global automation** on `macs-holding.atlassian.net`. One global rule covers every configured space. Project automation would need the same rule once per space.
2. Create a rule named **Omegent: bug created**.
3. Scope it to the configured spaces only. Today that is **SA** and **CFG**. A space counts only when it is in `T3CODE_JIRA_PROJECT_MAP` and, if `T3CODE_JIRA_ALLOWED_PROJECTS` is set, in that list too. Add a space to the rule only when you add it there.
4. Trigger: **Work item created** (Issue created). Do not use Work item updated, Comment created, or Assign. Those stay on their own rules.
5. Condition: **Issue type equals Bug**. The type name must be Bug. A Story, Task, or another type is ignored. The server checks the same thing.
6. Action: **Send web request**.
   - Web request URL: the same URL as the comment rules, `https://omega.omegent.com/api/jira/webhook`
   - HTTP method: **POST**
   - Web request body: **Custom data**. Do not use Issue data (Automation format). That shape is not an issue-created webhook.
   - Headers: copy them from a comment rule. The server accepts either `Authorization: Bearer <secret>` or `X-T3-Webhook-Secret: <secret>`. The value is `T3CODE_JIRA_WEBHOOK_SECRET`. Also send `Content-Type: application/json`. Do not put the secret in git, in this page, or in a screenshot of the audit log.
   - Custom data: paste the template below. Every text field uses `.asJsonString`, which includes the JSON quotes and escapes newlines and quotes. A raw `{{issue.description}}` inside quotes breaks the body, and the server then drops the delivery as invalid JSON.
7. Turn the rule **on**.

```json
{
  "webhookEvent": "jira:issue_created",
  "issue_event_type_name": "issue_created",
  "user": {
    "accountId": {{initiator.accountId.asJsonString}},
    "displayName": {{initiator.displayName.asJsonString}}
  },
  "issue": {
    "id": "{{issue.id}}",
    "key": {{issue.key.asJsonString}},
    "self": "https://macs-holding.atlassian.net/rest/api/3/issue/{{issue.id}}",
    "fields": {
      "summary": {{issue.summary.asJsonString}},
      "description": {{#if(issue.description)}}{{issue.description.asJsonString}}{{else}}""{{/}},
      "issuetype": { "name": {{issue.issueType.name.asJsonString}} },
      "project": { "key": {{issue.project.key.asJsonString}} },
      "reporter": {
        "accountId": {{issue.reporter.accountId.asJsonString}},
        "displayName": {{issue.reporter.displayName.asJsonString}}
      }
    }
  }
}
```

`self` has to be that REST issue address. The server turns it into the browse link. `webhookEvent` has to be `jira:issue_created` (or `issue_created`). A comment rule that also carries `issue_event_type_name: issue_created` stays a comment, as long as its own `webhookEvent` is still `comment_created` or `comment_updated`.

Bugs filed by `T3CODE_JIRA_BOT_ACCOUNT_ID` are skipped, so the bot cannot review a bug it filed itself. A review comment does not create an issue, so it does not start this rule again. The same issue id is delivered once. Editing the bug later does not start another review.

Check, in order:

1. In the rule audit log, the web request returns **202**. **401** means the secret header does not match. **400** with invalid JSON means a smart value was not escaped. **404** means the Jira integration is disabled on the server.
2. File a Bug in SA as a person, with a summary and a description that contain a quote and a line break. The debug log records `accepted_202` for `jira:issue_created`. The issue later gets the analysis comment, then the fix comment. Both mention the mapped team.
3. File a Story in SA. The log records `ignored_202` with reason `not_bug:story`. No review starts.
4. File a Bug in a project that is not in the map. The log records `project_denied_202`. No review starts.
5. Mention the bot on an existing issue. That comment rule still runs, and the reply is still threaded under the mention.

## Security

- Require a shared secret on every delivery (`Authorization: Bearer …` or `X-T3-Webhook-Secret`).
- Cap body size at 1 MiB.
- Comment turns accept `comment_created` and `comment_updated` only, and only with an explicit mention.
- Bug turns accept `jira:issue_created` for issue type Bug in a configured space. The report text is data. The analysis and the proposed fix are commented on the issue.
- Assignment turns accept only assignments of the configured bot.
- Allowlist projects when configured.
- Do not put secrets in prompts, delivery logs, or git.
- Prefer the free Atlassian **service account** for REST replies (see
  [atlassian-service-accounts](./atlassian-service-accounts.md) when present on the branch).

## Outbound comments

Responses are posted as issue comments authored by the service account, preferably as a
**threaded reply** under the triggering mention (REST body field `parentId` — supported on Jira
Cloud even though it is lightly documented). The body **@-mentions** the human requester via an ADF `mention` node:

```json
{
  "type": "mention",
  "attrs": {
    "id": "<bare Atlassian accountId>",
    "text": "@Display Name",
    "accessLevel": ""
  }
}
```

`attrs.id` is the **bare** account id from the webhook author (e.g. `6331c323…` or
`712020:uuid`) — the same shape returned by GET comment bodies on this site — not the wiki
`[~accountid:…]` form and not plain `@Name` text alone.

**Inline threading (required for reliable replies):** Jira Cloud only accepts children under a
**root** comment. POST with `parentId` set to a nested reply id returns **400**
(`Parent comment not found, and no child comments exist`) — the bridge used to fall back flat.
Before posting, `JiraAppClient` GETs `/rest/api/3/issue/{key}/comment/{id}` and uses that
comment’s `parentId` when set (else the id itself). Webhooks should send either `comment.parentId`
(REST shape) or `comment.parent.id` when known; empty Automation fields are ignored. Only if every
resolved root is rejected does the bridge fall back to a top-level comment (logged as error when
the create response lacks `parentId`).

**Busy threads:** follow-up mentions always dispatch `thread.turn.start`. Orchestration queues the
message while a turn is running; the bridge does **not** post an “already working” short-circuit.
The reply still posts asynchronously when the turn completes (`bridgeTurn` is fork-detached).

Replies are Markdown, stored as Atlassian document nodes (headings, links, lists, tables, and code
blocks) so the comment does not show the source. Do not @-spam watchers unless the agent explicitly
mentions users. A reply that exceeds the comment limit is not cut mid-sentence: the comment keeps
what fits and links to the rest on the assigned Confluence page, or to a Markdown attachment when
that page is not configured or the write is rejected.

## Testing checklist

1. Unit: mention extraction for plain text, wiki, and ADF; parent comment id; bot/self skip.
2. Unit: webhook secret acceptance / rejection; project allowlist.
3. Unit: delivery dedupe on redelivery of the same comment id.
4. Unit: webhook debug retention prune (24h) and body failure classification.
5. Integration (manual): register a Jira webhook or Automation rule → `POST /api/jira/webhook`
   with the shared secret; mention the bot on a linked issue; confirm a reply comment and a
   matching `accepted_202` (or `invalid_400` with preview) line in `jira-webhook-debug.ndjson`.

## Non-goals (this foundation)

- Creating worktrees or projects from Jira
- Full comment-edit re-routing
- Confluence page mentions
- Jira Service Management customer portal public/internal split (beyond posting internal comments later)
- Real-time streaming of intermediate assistant text into Jira (final answer only)
