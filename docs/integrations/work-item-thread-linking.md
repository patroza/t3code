# RFC: Cross-surface work-item → thread linking

**Status:** draft (ideas only — no implementation commitment)
**Scope:** How T3 should **find** an existing thread when ingress arrives from Jira, GitHub, or
Discord, without inventing vague “relatedness”
**Related:** [Jira issue conversations](./jira-issue-conversations.md),
[GitHub PR conversations](./github-pr-conversations.md),
`apps/server/src/workItems/ThreadWorkItemStore.ts`

## Problem

Inbound bridges need a T3 thread:

| Surface            | Today’s resolution                                        |
| ------------------ | --------------------------------------------------------- |
| GitHub PR mention  | Worktree / PR → unique live thread (lookup-only)          |
| Jira issue mention | Exact Jira key → unique record in `ThreadWorkItemStore`   |
| Discord            | Bot `links.json` / pins; may import into the server store |

Users experience gaps like:

1. A **PR thread** is already open and working on `SA-401`, but the store only has the **GitHub PR**
   ref — a Jira `@Omegent` on `SA-401` returns **not yet linked**.
2. A **Discord** thread has both PR and Jira in chat history, but only one side was ever written to
   the server store.
3. Two threads both “feel” related to the same issue (sibling worktrees, reopened PR, fork) —
   auto-picking is dangerous.

“Somehow related” is not an implementable rule. This doc proposes **explicit identities**, a
**priority ladder**, and a **write-path** strategy so lookup stays fail-closed and boring.

## Goals

- One conceptual model: **thread ↔ external work items**, independent of Discord.
- Prefer **find existing thread** over create; Jira (and GitHub) foundations stay **lookup-only**
  unless product later opts into create.
- Never silent-route on soft similarity.
- Make the common miss (PR thread missing Jira key) fixable by **indexing**, not AI guesswork.

## Non-goals (this draft)

- Embedding / title similarity as silent auto-routing
- Auto-merging two agent sessions
- Full multi-tenant work-item graph UI
- Replacing GitHub’s own PR↔thread worktree resolver

## Current backbone (keep)

`ThreadWorkItemStore` (`stateDir/thread-work-items.json`) records per thread:

- `jiraIssueKeys[]` (normalized `PROJ-123`)
- `githubPullRequests[]` (normalized `github.com/owner/repo/pull/n`)
- `sources[]` (provenance: `discord`, `jira-webhook`, `github-webhook`, `manual`, …)

**Lookup policy (fail-closed):**

| Matches | Result                              |
| ------- | ----------------------------------- |
| 0       | unlinked — system message, no turn  |
| 1       | linked — dispatch to that thread    |
| \>1     | ambiguous — system message, no turn |

That policy should remain the default for automated ingress.

```text
                    ┌─────────────────────┐
  GitHub PR ───────►│                     │
  Jira key  ───────►│ ThreadWorkItemStore │──► 0 / 1 / many threads
  Discord import ──►│  (exact ids only)   │
  manual / agent ──►│                     │
                    └─────────────────────┘
```

## Definition of “related” (normative)

> Two ingresses target the **same T3 thread** if and only if they share at least one
> **normalized work-item identity** already stored on that thread (Jira key or GitHub PR ref),
> **or** a human/agent has **explicitly** attached such an identity.
>
> Same git worktree / PR stack is a **candidate signal** only when it yields a **single** live
> thread **and** there is a proven L1 path from the inbound id to that worktree.
>
> Everything else is **unlinked** or **user-mediated** — never silent auto-dispatch.

## Priority ladder

Higher levels may auto-route. Lower levels only suggest or refuse.

### L0 — Exact work-item id (shipped)

- Same normalized Jira key → thread
- Same normalized GitHub PR ref → thread

**Policy:** auto-route when unique.

### L1 — Explicit cross-links already on the thread (partially shipped)

Thread may hold **both** PR and Jira keys. Either ingress then hits L0.

**Gap:** first Jira ping when only PR was ever stored (or only Discord).

**Policy:** still L0 only. The fix is **write-path completeness** (below), not looser read-path.

### L2 — Same worktree / PR stack (candidate)

“Related” = same live worktree path or same stack root as an existing thread.

**Policy ideas:**

- Exactly one live thread on that worktree → may **prefer** or auto-route **only if** L1 already
  mapped inbound id → that worktree/PR
- Multiple threads → ambiguous

Do **not** jump from bare `SA-401` to “newest dirty worktree in scanner” without a proven map.

### L3 — Soft signals (chooser only)

Examples (non-exhaustive):

- Issue key in PR title/body but not yet indexed
- Same human author recently active on a candidate thread
- Open PR in allowlisted repo that _mentions_ the issue in description
- Title similarity

**Policy:**

- **Never** auto-dispatch
- Optional future UX: short chooser (“2 candidates — reply `1`/`2` or link explicitly”)
- Or Discord/web: “Attach SA-401 to this thread”

### L4 — Create (opt-in product decision)

Jira foundation today: **lookup-only**. Creation requires:

- Explicit user intent, **or**
- A configured default project/repo mapping (`SA` → scanner workspace), **and**
- Clear ownership of the new thread

Default create-on-mention will produce orphan sessions and duplicate work.

## Write-path strategy (highest ROI)

Most “why didn’t Jira find my PR thread?” failures are incomplete **writes**, not dumb **reads**.

### Idea A — Index Jira keys when the GitHub bridge accepts a PR

On successful GitHub PR resolve / dispatch:

1. Extract issue keys from PR title, body, branch name (reuse false-positive filters in
   `normalizeJiraIssueKey`).
2. Optionally call GitHub “linked issues” / Development panel APIs when available.
3. `appendForThread({ jiraIssueKeys, githubPullRequests, source: "github-webhook" })`.

**Effect:** subsequent Jira `@Omegent` on that key hits L0 without human linking.

### Idea B — Index both sides from Discord

When Discord pins/links a thread:

- Continue writing Jira keys **and** PR URLs into the server store (not only `links.json`).
- On import fallback, always promote **full** multi-key records.

### Idea C — Agent / MCP as a writer

When the agent successfully posts to Jira issue `SA-401` from a thread (MCP), append `SA-401` to
that thread’s store entry (source: `agent-mcp` or `jira-mcp`).

**Caution:** only after a **successful** issue-scoped write, and only for the active thread — avoid
polluting from casual `jira_search`.

### Idea D — Explicit link commands

- Discord `/t3 link SA-401` / link PR URL
- Web/thread menu “Attach work item”
- Agent tool `workItems.attach` (authenticated)

These are the escape hatch when extraction fails.

## Read-path UX improvements (still fail-closed)

Keep `not yet linked` / ambiguous, but make them actionable:

```text
not yet linked.

No T3 thread lists SA-401 yet. Open or continue the PR/Discord thread for this work, or attach
the issue from T3 / Discord. If a PR already references SA-401, re-run after the PR bridge has
indexed keys (or link manually).
```

Ambiguous:

```text
Multiple T3 threads list SA-401: …
Attach the issue to exactly one thread, or reply from that thread’s linked surface.
```

(Exact copy TBD; avoid dumping internal UUIDs unless useful.)

## Open questions

1. **Branch-name extraction:** How aggressive? (`feature/SA-401-foo` yes; `fix/utf-8` no — already
   have false-positive set.)
2. **Multi-issue PRs:** One PR → many Jira keys is fine (array). One Jira key → many PRs/threads
   stays ambiguous.
3. **Sibling / stack threads:** Should stack children inherit parent’s Jira keys automatically?
4. **Stale links:** Archive/delete thread — purge store rows? Leave and let projection “thread
   missing” fail closed?
5. **Create-from-Jira:** Project key → default git remote + path mapping config shape?
6. **Chooser UX:** Jira comment reply vs only Discord/web (Jira picker is awkward)?

## Proposed phased delivery (not scheduled)

| Phase | Work                                                                                  | Outcome                                 |
| ----- | ------------------------------------------------------------------------------------- | --------------------------------------- |
| **0** | This doc                                                                              | Shared language                         |
| **1** | GitHub bridge indexes Jira keys from PR title/body/branch                             | Most PR↔Jira misses disappear           |
| **2** | Discord/server store always dual-write keys + PRs; agent attach after MCP issue write | Graph fills from all surfaces           |
| **3** | Better unlinked/ambiguous copy; optional manual link UX                               | Operators unstuck without guess routing |
| **4** | Soft-candidate chooser (L3)                                                           | Only if Phase 1–3 still leave a gap     |
| **5** | Opt-in create-from-Jira                                                               | Product call                            |

## What we will not do

- Silent “best matching thread in project SA”
- Embeddings as primary router
- Auto-merge concurrent agents on two surfaces into one thread without explicit link
- Treat empty `ThreadWorkItemStore` as permission to create from every Jira ping

## References (code)

- `apps/server/src/workItems/ThreadWorkItemStore.ts` — store + normalize helpers
- `apps/server/src/jira/JiraIssueBridge.ts` — Jira resolve + append on accept
- `apps/server/src/github/GitHubPrBridge.ts` — PR resolve / worktree affinity
- Discord bot links import path via `T3CODE_JIRA_DISCORD_LINKS_PATH`

## Discussion prompts for review

1. Is **Phase 1 (index keys from PR text)** the right first implementation PR?
2. Should stack/sibling threads **inherit** parent work-item keys?
3. Do we want agent MCP writes to auto-attach issue keys, or keep attachment explicit?
4. Any allowlisted false positives beyond the current key normalizer set?
