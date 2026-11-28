# RFC: GitHub PR conversations

**Status:** implemented MVP
**Scope:** GitHub.com pull-request comments backed by an existing T3 thread and worktree

## Summary

An authorized GitHub user can mention the T3 GitHub App in a pull-request conversation or an inline
review comment and continue the T3 thread linked to that PR.

Thread resolution uses the threads' **pull request links** (the same links the thread header shows,
that opening a PR from a thread records, and that `link_pull_request` creates), plus the PR T3
detects for a thread's branch. The GitHub entry point **joins or provisions**:

1. **Linked thread**: the thread that opened the PR, else a thread that links it, else a thread whose
   branch is the PR's branch; the oldest wins a tie.
2. **Provision**: when no thread is linked, prepare a PR worktree on the one T3 project whose
   repository (either remote of a fork checkout) matches, create a thread there, and link the PR to it.

It never creates a **project**. A Jira-first or Discord-first session continues on GitHub once its
PR is linked to the thread, which happens when the thread opens the PR or T3 detects it on the
thread's branch.

## User experience

The bridge handles two GitHub comment surfaces on pull requests:

| Surface         | Webhook event                         | Where you write              | Where T3 replies            |
| --------------- | ------------------------------------- | ---------------------------- | --------------------------- |
| PR conversation | `issue_comment.created`               | Conversation tab             | New conversation comment    |
| Inline review   | `pull_request_review_comment.created` | Files changed (line comment) | Reply in that review thread |

A turn starts only when a non-bot user writes an explicit configured mention followed by a prompt:

```text
@t3-code investigate why the Windows check is failing
```

On an inline review comment, the same mention works and the agent receives the file path, line, side,
and diff hunk from the review comment:

```text
@t3-code please fix this null check
```

### Thread mode (session selection)

Both surfaces share the **PR worktree** (the linked thread's checkout). Sessions differ:

| Surface           | Default     | Behavior                                                                                                                |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Conversation**  | **main**    | Reuse the thread linked to the PR                                                                                       |
| **Inline review** | **sibling** | First `@mention` in a GH review discussion creates a T3 session; later `@mention`s in **that same discussion** reuse it |

Overrides (stripped from the prompt):

| Flag                                                   | Effect                                                                |
| ------------------------------------------------------ | --------------------------------------------------------------------- |
| `main-thread` / `--thread main`                        | Force the PR work thread                                              |
| `sibling-thread` / `--thread sibling` / `--thread new` | Force a **new** sibling session (and rebind that GH discussion to it) |

So: new T3 thread only when starting an unbound inline discussion, or when forced. Continuing a tagged review thread stays on the assigned session until the user switches.

The app:

1. Verifies the webhook signature and deduplicates the delivery.
2. Checks the repository allowlist and the requester's current repository permission.
3. Checks the requester against the identity map (`github.login` / `github.id`); unmapped accounts are refused.
4. Resolves session: main PR thread, existing review-discussion binding, or create sibling on the PR worktree.
5. Acknowledges the source comment with an eyes reaction, starts a turn, and posts the final answer
   (conversation comment or in-thread review reply).

If the chosen T3 thread is already running, the app asks the user to retry instead of queuing. Edited
comments, mention-free comments, normal issue comments (non-PR), and app-authored comments are ignored.

## Link definition

The PR link is the thread's own pull request link, so the PR shows in the thread header and the
thread shows in the PR's linked threads. The bridge links the PR to the main thread it joins or
creates; sibling sessions share the branch and do not get an explicit link, so the main thread keeps
winning later mentions. Unlinking the PR from a thread, archiving it, or linking the PR to a second
thread changes which thread the next conversation mention continues.

## Architecture

```text
GitHub App issue_comment | pull_request_review_comment webhook
        |
        v
POST /api/github/webhook
  raw-body HMAC verification
  payload/schema validation
  delivery-id dedupe
        |
        v
GitHubPrBridge
  repository allowlist
  actor permission lookup
  parse thread mode (conversation→main, review→sibling+affinity; flags override)
  identity map trust (fail closed)
  resolve: thread linked to the PR | bound review-discussion session | create sibling
        |
        v
OrchestratorV2.dispatch(message.dispatch)
  (inline review: path/line/diff hunk in prompt context)
        |
        v
thread projection polling
  --> issue surface: create/update Issues API comment
  --> review surface: create/update review-thread reply
```

Implementation lives under `apps/server/src/github/`. It runs inside the T3 server so it uses the same
orchestration projection and command engine as the web application.

## Security model

- Verify `X-Hub-Signature-256` against the exact raw request body before decoding JSON.
- Accept at most 1 MiB per webhook body.
- Accept only `issue_comment` and `pull_request_review_comment` events with a non-empty
  `X-GitHub-Delivery` id.
- Ignore bot actors and require an explicit configured mention.
- Require the repository to be enabled and the actor to meet the configured permission floor
  (`write` by default).
- Treat all GitHub fields and comment text as untrusted user input in the generated T3 prompt.
- Use a GitHub App installation token for permission checks and PR comment writes.
- Keep the webhook secret and private key out of prompts, logs, persisted deliveries, and git config.
- Require the actor to be a mapped person in the identity map; repository write access alone is never
  enough (including on public repositories).

Private repositories should set `T3CODE_GITHUB_ALLOWED_REPOSITORIES`; an empty value allows every
repository on which the app is installed. Entries are `owner/repo` or `owner/*` (every repository
under that owner).

## Reliability

Processed deliveries are persisted atomically in:

```text
${T3CODE_HOME}/userdata/github-webhook-deliveries.json
```

Inbound webhook intake is also logged (24h retention) to:

```text
${T3CODE_HOME}/userdata/github-webhook-debug.ndjson
```

Each row records outcome (`accepted_202`, `ignored_202`, `invalid_400`, `unauthorized_401`,
`repo_denied_202`, …), delivery id, and a capped body preview on failures. Best-effort only.

Development mode uses the corresponding dev state directory. The newest 2,000 deliveries are kept.
Claiming a delivery is serialized, so a GitHub retry cannot create a second T3 turn. Each record stores
the response comment, T3 thread, and previous turn id.

On restart, processing records resume projection polling and finalize the original GitHub comment.
Installation tokens are cached briefly and renewed automatically. A response longer than GitHub's
comment limit is truncated explicitly.

Temporary GitHub/T3 failures are logged and answered with a stable failure response.

## Configuration

| Variable                             | Required | Default             | Purpose                                           |
| ------------------------------------ | -------- | ------------------- | ------------------------------------------------- |
| `T3CODE_GITHUB_APP_ID`               | yes      | —                   | Numeric GitHub App id                             |
| `T3CODE_GITHUB_APP_PRIVATE_KEY_PATH` | yes      | —                   | Path to the downloaded PEM key                    |
| `T3CODE_GITHUB_WEBHOOK_SECRET`       | yes      | —                   | Shared webhook HMAC secret                        |
| `T3CODE_GITHUB_APP_MENTION`          | yes      | —                   | Mention handle without `@`                        |
| `T3CODE_GITHUB_ALLOWED_REPOSITORIES` | no       | all installed repos | Comma-separated `owner/repo` or `owner/*`         |
| `T3CODE_GITHUB_MIN_PERMISSION`       | no       | `write`             | `read`, `triage`, `write`, `maintain`, or `admin` |
| `T3CODE_GITHUB_TURN_TIMEOUT_MS`      | no       | `1800000`           | Response bridge timeout, minimum 10 seconds       |

The route returns 404 unless all four required variables are configured.

### Agent MCP PR tool routing (`github-apps.json`)

Agent MCP PR tools (`pull_request_create`, `pull_request_update`, `pull_request_respond`, `pull_request_review`, `pull_request_merge`, `pull_request_read`, `pull_request_list`, `ci_logs`, `ci_rerun`) can route per owner or per repository through `~/.config/t3/github-apps.json` (or `T3_GITHUB_APPS_FILE`):

```json
{
  "apps": [
    {
      "name": "project-opener",
      "appId": 123456,
      "privateKeyPath": "~/.config/t3/opener.pem",
      "owners": ["my-org"],
      "repos": ["other-owner/specific-repo"],
      "reviewer": {
        "name": "project-reviewer",
        "appId": 654321,
        "privateKeyPath": "~/.config/t3/reviewer.pem"
      }
    }
  ]
}
```

- Entries match by `repos` first, then `owners` (case-insensitive). Unmapped repositories use the personal login.
- When an entry defines `reviewer`, the intended flow is the conventional split: the author (opener App) opens the PR and enables GitHub auto-merge (`pull_request_merge` with `auto: true`) when it is ready; the `reviewer` App runs `pull_request_review` (all verdicts: `approve`, `request-changes`, `comment`, including inline line comments and the diff/permission/head checks performed during review) and GitHub merges automatically once checks and approval are in. Direct `pull_request_merge` without `auto` (including `stack`) also routes through the `reviewer` App as a fallback where auto-merge cannot be used.
- All other MCP PR tools (`pull_request_create`, `pull_request_update`, `pull_request_respond`, `pull_request_merge` with `auto: true`, `ci_rerun`, and standalone reads) keep the opener App.
- Writes fail closed: if a configured `reviewer` App's key, installation lookup, or token mint fails, `pull_request_review` and direct `pull_request_merge` return an error instead of falling back to the opener App or personal login. Entries without `reviewer` keep using the opener App.

## Failure semantics

| Condition                                      | Result                                                 |
| ---------------------------------------------- | ------------------------------------------------------ |
| No linked thread and no matching T3 project    | Reply that no project is linked to the repository      |
| No linked thread and several matching projects | Reply that the project is ambiguous                    |
| Worktree preparation fails                     | Reply that the worktree could not be created           |
| Unauthorized repository or permission          | Silently ignored; no response, no turn                 |
| Actor not in the identity map                  | Authorization response; no turn                        |
| Thread already running                         | Busy response; no queue and no turn                    |
| Duplicate delivery                             | Reuse persisted classification; no new comment or turn |
| Turn completes                                 | Post the final answer with a small turn-stats footer   |
| Turn errors or is interrupted                  | Post a stable failure response                         |
| Server restarts during turn                    | Resume the persisted response bridge                   |

Provision still shells out to `gh` for PR metadata. Transient App installation-token
auth failures (exit 4 / 401) are retried **inside the guest `gh-app-wrapper`** (wait,
remint `--no-cache`, one retry)—not in this bridge—so agents and status polls get the
same fix. That wrapper ships with the microVM image (`infra/microvm/github-app` in ops).

## Tests and acceptance criteria

Automated coverage includes raw-body signatures, invocation parsing, bot/issue/empty-prompt ignores,
permission ordering, GitHub App JWT signing, repository matching, and linked-thread selection.

End-to-end acceptance:

1. Open a PR from a T3 worktree thread (or link one to it).
2. Mention the app with a prompt on that PR conversation.
3. Confirm exactly one new user turn appears in the same T3 thread and its final answer is posted as a
   conversation comment.
4. Mention the app on an inline Files-changed review comment on the same PR.
5. Confirm the reply lands in that review thread and the turn prompt includes path/line context.
6. Redeliver the same webhook and confirm no duplicate comment or turn appears.

## Deferred scope

- Approval and structured user-input interactions in GitHub.
- GitHub Checks output.
- Durable relay ingress for environments that cannot expose the local server directly.
- Replacing the source-control implementation's personal `gh` and git credentials with GitHub App
  installation credentials.
- **Provision auth hardening** (guest `gh-app-wrapper` remint-on-401 ships in ops; rest still open):
  - Resolve PR head/base via `GitHubAppClient` (webhook installation token) instead of CLI `gh`
  - Post the real provision error on the PR comment (not only “check server logs”)
  - Always pass `-R owner/repo` from the bridge; fix App-mode errors that still say `gh auth login`
  - Server token cache under `XDG_RUNTIME_DIR` / `T3_GITHUB_APP_TOKEN_CACHE_DIR`, not agent `TMPDIR`
  - Cut `lookupStatusPr` `gh` noise; prune expired installation-token cache files
