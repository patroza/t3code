# Conversation Search — State, Gap Analysis & Design Notes

Agent tools across the ecosystem (Codex CLI, Claude CLI, VS Code chat) ship rich
_scoped_ search — command palettes, model/file pickers — but almost none let you
**search the content of your past conversations**. T3 Code is largely the same.
This document records what search exists today, what's missing, why the gap is
so common, the upstream issues/PRs that track it, and a design sketch for
closing it.

## What "search" exists in T3 Code today

There is a lot of _scoped picker_ search, all built on the shared ranking
helper `normalizeSearchQuery` / `scoreQueryMatch`
(`packages/shared/src/searchRanking.ts`):

- **Command palette** — searches **thread titles** and project titles/paths, and
  lists recent threads (`RECENT_THREAD_LIMIT = 12`,
  `apps/web/src/components/CommandPalette.logic.ts`). It does **not** match
  message content.
- **Model picker** (`apps/web/src/components/chat/modelPickerSearch.ts`),
  **file browser** (`apps/web/src/components/files/FileBrowserPanel.tsx`),
  **composer slash-commands** (`composerSlashCommandSearch.ts`), **path / skill
  autocomplete** (`providerSkillSearch.ts`, `lib/composerPathSearchState.ts`).

All of these are "pick a known entity by name" search — none of them search the
transcript.

## What's missing

### 1. In-thread content find (Cmd/Ctrl+F) — _in progress_

There is no in-thread find on `main`. Native browser / Electron find does not
work because the transcript is **virtualized** (`LegendList`): off-screen
messages are not in the DOM, so a browser find misses most of the conversation.

This is being addressed by **open PR
[#3539](https://github.com/pingdotgg/t3code/pull/3539) — feat(web): add
Ctrl/Cmd+F find-in-chat** (branch `feat/find-in-chat`). Its approach is the
correct one: **search the data model, not the DOM** — `chatSearch.ts` projects
each timeline entry (user/assistant messages, tool/work entries, proposed plans,
including collapsed content) to searchable text, renders a floating find bar
with an `N/total` counter, Enter / Shift+Enter (or ↑/↓) navigation, and match
highlighting. It answers issue
[#1486](https://github.com/pingdotgg/t3code/issues/1486)'s in-thread half.

### 2. Cross-thread content search — _unaddressed_

The real gap. You cannot search the _content_ of past conversations across all
threads — only jump to a thread by **title**. The canonical use case
(from [#3509](https://github.com/pingdotgg/t3code/issues/3509)): "I remember
solving a bug or writing a snippet in some session weeks ago" — today the only
recourse is to remember the thread's title. There is **no issue-linked PR** and
no implementation.

### 3. Sidebar / thread filtering — _adjacent, unaddressed_

Not content search, but the same "find the right thread among many" problem:
global thread filters in the Projects sidebar
([#1043](https://github.com/pingdotgg/t3code/issues/1043)) and archive
enhancements ([#2935](https://github.com/pingdotgg/t3code/issues/2935)).

## Why this gap is near-universal

It is not a simple oversight; several forces push it below the fold everywhere:

1. **The data model fights it.** Transcripts are not flat text — they are event
   streams (user turns, streamed assistant deltas, reasoning, tool calls, diffs,
   approvals, images). "Search" first requires deciding _what a hit is_ (my
   prompt? assistant prose? tool stdout? a path inside a diff?). PR #3539's
   "project each entry to searchable text" is exactly this decision made
   explicit — and it is real design work, not a checkbox.
2. **Built around the current task, not an archive.** History is treated as
   scrollback. CLIs punt hardest — the terminal/pager "already owns" find, so
   authors assume you scroll or `grep` the session file.
3. **Indexing is unglamorous infra.** Cross-thread content search wants a
   persistent, maintained full-text index (e.g. SQLite FTS). History is often
   append-only JSONL (Codex/Claude session files) or, in T3 Code, server-side
   event-sourced projections. An index means write-path cost, migrations, and
   staleness handling — easy to defer while a product is young.
4. **It pays off late.** Search only becomes valuable once there is a lot of
   history worth searching, so it sits behind provider support, reliability, and
   new-model work on the roadmap.
5. **The "ask the agent" bet.** The implicit philosophy is that you _ask_ the
   agent to recall instead of searching a UI. Memory/RAG is meant to replace
   search — but it is lossy today, so the replacement under-delivers and no
   fallback UI was built.
6. **VS Code chat specifically** grafts chat onto an editor whose identity _is_
   search (files, symbols, ripgrep); the team polished editor search and treated
   chat as a transient side panel.

## Why T3 Code is well-positioned to fix it

Unlike the file-based CLIs, T3 Code already has the substrate for real search:

- A **server-side store with event-sourced thread/message projections**
  (`apps/server/src/orchestration/…`) — the messages are already persisted and
  queryable server-side, not just scrollback.
- A **command palette** that is the obvious home for a "Search conversations…"
  entry (`apps/web/src/components/CommandPalette.tsx`).
- A **shared ranking helper** (`packages/shared/src/searchRanking.ts`) and now,
  via PR #3539, a **timeline-entry-to-text projection** (`chatSearch.ts`) that a
  server-side indexer could reuse for consistent hit semantics.

## Design sketch (cross-thread content search)

Non-binding, to seed discussion on #3509:

- **Index server-side.** Add a full-text index over message/turn content in the
  orchestration store (SQLite FTS5 or equivalent), populated from the same
  projection pipeline that already writes thread history. Reuse PR #3539's
  entry→text projection so in-thread find and cross-thread search agree on what
  is searchable.
- **Expose a `searchThreads`/`searchMessages` RPC** in the orchestration
  contract (`packages/contracts/src/orchestration.ts`) returning ranked hits
  with `threadId`, message id, and a snippet + offsets for highlighting.
- **Surface in the command palette** as a dedicated "Search conversations" mode
  (distinct from the current title/recent-thread mode), with result rows that
  deep-link to the thread and scroll/highlight the matching entry (reusing the
  find-in-chat highlight from #3539).
- **Scope & filters.** Support project scoping and the sidebar filters from
  #1043 (status/archived) as search facets so the two features compose.
- **Incremental delivery.** (a) ship in-thread find (#3539) → (b) title +
  content search of _loaded_ threads client-side → (c) server-side FTS across
  all threads. Each step is independently useful.

## Upstream tracking (pingdotgg/t3code)

As of 2026-07-04:

| Item                                                                                                                      | Type / State                            | Relevance                                                                  |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | -------------------------------------------------------------------------- |
| [#3539](https://github.com/pingdotgg/t3code/pull/3539) — feat(web): add Ctrl/Cmd+F find-in-chat                           | **PR, open**                            | In-thread find (data-model based). Implements the in-thread half of #1486. |
| [#1486](https://github.com/pingdotgg/t3code/issues/1486) — Add search within the thread/chat                              | Issue, open (enhancement, needs-triage) | In-thread find **+** sidebar search. Partially covered by #3539.           |
| [#3509](https://github.com/pingdotgg/t3code/issues/3509) — Search across all threads by message content (not just titles) | Issue, open                             | **The core gap.** No PR.                                                   |
| [#1043](https://github.com/pingdotgg/t3code/issues/1043) — Global thread filters in Projects sidebar                      | Issue, open (enhancement)               | Adjacent: filter, not content search. Compose as facets.                   |
| [#2935](https://github.com/pingdotgg/t3code/issues/2935) — Archive enhancements                                           | Issue, open                             | Adjacent: archived-thread discoverability.                                 |

**Summary:** in-thread find has an in-flight PR (#3539); cross-thread content
search (#3509) is the unaddressed piece and the highest-leverage feature to add,
and T3 Code's event-sourced store makes it more tractable here than in any
file-based CLI.

## Key references

| Concern                               | Location                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Shared search ranking                 | `packages/shared/src/searchRanking.ts`                                                              |
| Command palette (title/recent search) | `apps/web/src/components/CommandPalette.logic.ts`                                                   |
| Model picker search                   | `apps/web/src/components/chat/modelPickerSearch.ts`                                                 |
| Slash-command / path / skill search   | `apps/web/src/components/chat/composerSlashCommandSearch.ts`, `apps/web/src/providerSkillSearch.ts` |
| File browser search                   | `apps/web/src/components/files/FileBrowserPanel.tsx`                                                |
| Orchestration store / projections     | `apps/server/src/orchestration/`                                                                    |
| Orchestration contract (RPC surface)  | `packages/contracts/src/orchestration.ts`                                                           |
