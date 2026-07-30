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
3. **Zero** hits → **auto-create** a T3 thread, attach the issue key, and run the turn. Project
   pick order: `T3CODE_JIRA_PROJECT_MAP` for the Jira project key (e.g. `SA`) →
   `T3CODE_JIRA_DEFAULT_PROJECT_ID` → sole shell project when exactly one exists. Disable with
   `T3CODE_JIRA_AUTO_CREATE_THREAD=false`.

Does **not** create projects, clone repositories, or invent checkouts (new threads start without a
worktree; later GitHub/Discord surfaces can join via the same store).

Agent-side Jira read/write for general tooling remains the shared Jira MCP (`mcp-atlassian`). This
bridge only owns **inbound webhooks** and **outbound response comments** for mention turns.

## User experience

| Surface       | Webhook event     | Trigger                                        | Where T3 replies                                     |
| ------------- | ----------------- | ---------------------------------------------- | ---------------------------------------------------- |
| Issue comment | `comment_created` | Explicit configured mention + prompt           | Threaded **reply** under the mention (`parentId`)    |
| Comment reply | `comment_created` | Mention in a comment with `parent` (when set)  | Threaded **reply** under the same thread root        |
| Comment edit  | `comment_updated` | Edited comment still contains mention + prompt | Threaded **reply** under the edited comment’s thread |

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
  best-effort 👀 reaction on trigger comment (cleared when done)
  parse mention + prompt (+ optional parent comment id)
  resolve unique T3 thread via ThreadWorkItemStore
    (optional Discord links.json import if still unlinked)
  join-or-create via PROJECT_MAP / DEFAULT_PROJECT_ID / sole project
  dispatch orchestration turn
  poll projection snapshot
        |
        v
Jira REST comment create (markdown → ADF, parentId reply when possible)
+ remove ack reaction
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
| `T3CODE_JIRA_ACK_EMOJI_ID`       | no       | `1f440` | Reaction on the trigger comment (`👀`); empty string disables     |
| `T3CODE_JIRA_BOT_ACCOUNT_ID`     | no       | —       | Alias for wiki/ADF `[~accountId:…]` mention matching              |

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

### Acknowledgment reactions

On accept, the bridge best-effort adds an eyes reaction (`1f440` / 👀 by default) to the
triggering comment, then removes it when the turn finishes or is rejected — same idea as Discord
and GitHub eyes. Jira Cloud’s public REST surface for comment reactions varies by site; failures
are logged and never block the turn.

## Security

- Require a shared secret on every delivery (`Authorization: Bearer …` or `X-T3-Webhook-Secret`).
- Cap body size at 1 MiB.
- Ignore events that are not `comment_created` / `comment_updated`.
- Allowlist projects when configured (`T3CODE_JIRA_ALLOWED_PROJECTS`).
- **Identity map trust gate** (when `T3_IDENTITY_MAP_PATH` has people):
  - **Trusted** — Jira `accountId` appears on a map person (`jira.accountId` / `jiraAccountId`) → full agent turn (same as today, including auto-create when enabled).
  - **Untrusted** — map on but actor missing/unmapped → **Discord context only** (no agent, no T3 transcript write). Posts a note into the unique Discord thread linked to the issue in `links.json` (`T3CODE_JIRA_DISCORD_LINKS_PATH` + `DISCORD_BOT_TOKEN`). Requires exactly one active Discord link with that issue key; never auto-creates. Jira reply explains the note was filed.
  - Map **off** / empty → legacy full access for all mentioners (backward compatible).
- Do not put secrets in prompts, delivery logs, or git.
- Prefer the free Atlassian **service account** for REST replies (see
  [atlassian-service-accounts](./atlassian-service-accounts.md) when present on the branch).

Map people with Jira links, for example:

```yaml
people:
  patroza:
    username: patroza
    name: Patrick Roza
    jira:
      accountId: "712020:your-atlassian-account-id"
    discord:
      id: "95218063095377920"
```

## Outbound comments

Responses are posted as issue comments authored by the service account, preferably as a
**threaded reply** under the triggering mention (REST body field `parentId` — supported on Jira
Cloud even though it is lightly documented). When the user mentioned the bot inside an existing
reply thread, the bridge parents under that thread’s **root** (Jira rejects nesting under a child).
If threading is rejected (invalid parent), the bridge falls back once to a top-level comment.

Prefer Markdown converted to a minimal ADF document for API v3. Do not @-spam watchers unless the
agent explicitly mentions users.

## Testing checklist

1. Unit: mention extraction for plain text, wiki, and ADF; parent comment id; bot/self skip.
2. Unit: webhook secret acceptance / rejection; project allowlist.
3. Unit: delivery dedupe on redelivery of the same comment id.
4. Unit: webhook debug retention prune (24h) and body failure classification.
5. Unit: identity map trust — mapped accountId → full; unmapped/missing → context-only; map off → full.
6. Unit: Discord links.json resolve by Jira issue key (unique / unlinked / ambiguous).
7. Integration (manual): register a Jira webhook or Automation rule → `POST /api/jira/webhook`
   with the shared secret; mention the bot on a linked issue; confirm a reply comment and a
   matching `accepted_202` (or `invalid_400` with preview) line in `jira-webhook-debug.ndjson`.
8. Integration (manual, map on): unmapped Jira user mention on a Discord-linked issue → note in the
   Discord thread + “context only” Jira reply; unmapped on unlinked issue → refuse without agent run.

## Non-goals (this foundation)

- Creating worktrees or projects from Jira
- Full comment-edit re-routing
- Confluence page mentions
- Jira Service Management customer portal public/internal split (beyond posting internal comments later)
- Real-time streaming of intermediate assistant text into Jira (final answer only)
