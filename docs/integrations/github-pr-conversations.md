# RFC: GitHub PR conversations

**Status:** implemented MVP
**Scope:** GitHub.com pull-request comments backed by an existing T3 thread and worktree

## Summary

An authorized GitHub user can mention the T3 GitHub App in a pull-request conversation and continue
the T3 thread whose checked-out worktree branch resolves to that PR.

The GitHub entry point is lookup-only. It never creates a project, clones a repository, checks out a
branch, creates or repairs a worktree, or creates a T3 thread. If no unique live match exists, the
complete response is exactly:

```text
not yet linked/checked out.
```

Setup and development webhook instructions are in
[GitHub App setup](./github-app-setup.md). For agent `gh`/`git` auth without a machine user, see
[GitHub App agent auth](./github-app-agent-auth.md). The longer in-process broker plan is
[GitHub App account migration](./github-app-account-migration.md).

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

Both surfaces share the **PR worktree** (the same checkout Discord/T3 use for that PR). Sessions differ:

| Surface           | Default     | Behavior                                                                                                                |
| ----------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------- |
| **Conversation**  | **main**    | Reuse the live T3/Discord PR work thread                                                                                |
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
3. Resolves session: main PR thread, existing review-discussion binding, or create sibling on the PR worktree.
4. Acknowledges the source comment with an eyes reaction, starts a turn, and posts the final answer
   (conversation comment or in-thread review reply).

If the chosen T3 thread is already running, the app asks the user to retry instead of queuing. Edited
comments, mention-free comments, normal issue comments (non-PR), and app-authored comments are ignored.

## Work-item store

When a GitHub invocation successfully resolves a T3 thread, the server records the PR URL in the
shared **ThreadWorkItemStore** (`stateDir/thread-work-items.json`) alongside any Jira issue keys.
That store is platform-agnostic (not Discord-only) and can later support reverse lookup, UI, and
agent tools without reading Discord bot state.

Live PR resolution below remains the primary GitHub link path for this MVP.

## Link definition

A PR is linked only while exactly one active T3 thread satisfies all of these conditions:

- `worktreePath` is non-null.
- `branch` is non-null.
- Git can inspect the worktree.
- T3's source-control provider resolves the branch to a GitHub PR.
- The resolved PR number and canonical URL match the webhook repository and PR.

This is a live PR/branch/worktree/thread relationship rather than a second mutable link database. It
supports both directions already present in T3:

- A PR checked out through `git.preparePullRequestThread` has its upstream configured and resolves to
  that PR.
- A PR created from an existing T3 worktree branch resolves through the branch's GitHub PR status.

Deleting the worktree, removing the thread, switching the branch to another PR, or producing multiple
matching threads immediately makes the lookup fail closed. The webhook never attempts repair.

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
  resolve: main PR thread | bound review-discussion session | create sibling
        |
        v
OrchestrationEngineService.dispatch(thread.turn.start)
  (inline review: path/line/diff hunk in prompt context)
        |
        v
ProjectionSnapshotQuery polling
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
- Use the checked-out branch's provider-resolved canonical PR URL; branch-name equality alone is never
  sufficient.

Private repositories should set `T3CODE_GITHUB_ALLOWED_REPOSITORIES`; an empty value allows every
repository on which the app is installed.

## Reliability

Processed deliveries are persisted atomically in:

```text
${T3CODE_HOME}/userdata/github-webhook-deliveries.json
```

Development mode uses the corresponding dev state directory. The newest 2,000 deliveries are kept.
Claiming a delivery is serialized, so a GitHub retry cannot create a second T3 turn. Each record stores
the response comment, T3 thread, and previous turn id.

On restart, processing records resume projection polling and finalize the original GitHub comment.
Installation tokens are cached briefly and renewed automatically. A response longer than GitHub's
comment limit is truncated explicitly.

Temporary GitHub/T3 failures are logged and do not get mislabeled as an unlinked PR. A missing thread,
missing worktree, failed branch resolution, repository mismatch, PR mismatch, or ambiguous match does.

## Configuration

| Variable                             | Required | Default             | Purpose                                           |
| ------------------------------------ | -------- | ------------------- | ------------------------------------------------- |
| `T3CODE_GITHUB_APP_ID`               | yes      | —                   | Numeric GitHub App id                             |
| `T3CODE_GITHUB_APP_PRIVATE_KEY_PATH` | yes      | —                   | Path to the downloaded PEM key                    |
| `T3CODE_GITHUB_WEBHOOK_SECRET`       | yes      | —                   | Shared webhook HMAC secret                        |
| `T3CODE_GITHUB_APP_MENTION`          | yes      | —                   | Mention handle without `@`                        |
| `T3CODE_GITHUB_ALLOWED_REPOSITORIES` | no       | all installed repos | Comma-separated `owner/repo` allowlist            |
| `T3CODE_GITHUB_MIN_PERMISSION`       | no       | `write`             | `read`, `triage`, `write`, `maintain`, or `admin` |
| `T3CODE_GITHUB_TURN_TIMEOUT_MS`      | no       | `1800000`           | Response bridge timeout, minimum 10 seconds       |

The route returns 404 unless all four required variables are configured.

## Failure semantics

| Condition                                      | Result                                                   |
| ---------------------------------------------- | -------------------------------------------------------- |
| No unique live PR/branch/worktree/thread match | Exactly `not yet linked/checked out.`                    |
| Missing/deleted worktree or T3 thread          | Exactly `not yet linked/checked out.`                    |
| Repository or PR mismatch                      | Exactly `not yet linked/checked out.`                    |
| Unauthorized repository                        | Silently ignored; no response, no turn                   |
| Unauthorized actor                             | Neutral authorization response; no link-state disclosure |
| Thread already running                         | Busy response; no queue and no turn                      |
| Duplicate delivery                             | Reuse persisted classification; no new comment or turn   |
| Turn completes                                 | Replace working/progress comment with final answer       |
| Turn errors or is interrupted                  | Replace comment with a stable failure response           |
| Server restarts during turn                    | Resume the persisted response bridge                     |

## Tests and acceptance criteria

Automated coverage includes raw-body signatures, invocation parsing, bot/issue/empty-prompt ignores,
permission ordering, GitHub App JWT signing, and the exact missing-link response.

End-to-end acceptance:

1. Check out a GitHub PR into a T3 worktree-backed thread.
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
  installation credentials; see the migration plan linked above.
