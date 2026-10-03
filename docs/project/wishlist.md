# Project Wishlist

Personal feature ideas for T3 Code, captured before they're ready to be filed
upstream or built. Each entry states the problem, a proposed shape, and the
smallest useful scope. Promote an entry to an upstream issue / implementation
when it's ripe.

---

## Reopen existing worktrees without an active thread

**Status:** idea · **Area:** apps/web + apps/server (composer workspace picker, VCS RPC)

### Problem / use case

Worktrees are currently discoverable through threads and indirectly through the
ref picker. If every thread associated with a worktree has been closed, the
worktree disappears from the sidebar even though it still exists on disk.

It is possible to create a draft in **Current checkout**, open the ref picker,
and select a ref marked `worktree`, but that path is not obvious. A user looking
for a workspace reasonably expects the workspace picker to list it.

### Proposed solution

Extend the existing **Current checkout** workspace dropdown to include existing
worktrees for the selected project and environment:

- Keep **Current checkout** and **New worktree** as the primary choices.
- Add an **Existing worktrees** group showing the branch/ref and a compact path.
- Selecting one creates or updates the draft with its `branch`, `worktreePath`,
  and worktree environment mode; it must reuse the checkout without running
  `git worktree add` or switching its ref.
- Make the worktree group searchable and give the popup a bounded height with
  proper keyboard-accessible scrolling/virtualization. Repositories may have
  many worktrees, so the list must not grow the dropdown beyond the viewport.
- Keep the ref picker's existing `worktree` badges as a complementary shortcut.

### Smallest useful scope

List attached, branch-backed worktrees in a scrollable **Existing worktrees**
section of the workspace picker and allow opening a new draft in the selected
worktree. Refresh the list when the picker opens and after worktree creation or
removal.

### Design notes

- The current ref-list implementation already reads
  `git worktree list --porcelain` and exposes a `worktreePath` on matching local
  refs. This can support a prototype.
- Prefer a dedicated `vcs.listWorktrees` RPC for the durable implementation so
  discovery is independent of ref search/pagination and can include detached
  HEAD worktrees and explicit prunable/missing-state handling.
- Worktree identity should be its canonical path, not its branch name. Branch
  and final path segment are display metadata.
- Scope discovery to the selected project and execution environment; a local
  worktree path is not assumed to exist in another environment.
- The existing **Current checkout** wording should remain unchanged. It refers
  to the project's primary checkout; existing worktrees are additional choices
  in the same workspace menu.

### Open questions

- Should existing worktrees appear only in the composer workspace picker, or
  also as threadless groups in the project sidebar?
- Should missing/prunable worktrees be hidden, disabled with an explanation, or
  offered with a prune action?
- When the list is long, is one searchable combined workspace menu sufficient,
  or should **Existing worktrees…** open a dedicated combobox/submenu?

---

## Per-project idea queue + pluggable integrations (deferred, provider-agnostic drafts)

**Status:** idea · **Area:** apps/web + apps/server (orchestration, MCP/RPC)

### Problem / use case

I frequently want to jot down an idea the moment it occurs, but often I can't or
don't want to dispatch it to an agent right then:

- My AI credits have run out, so no provider can run it now.
- I haven't decided **which** provider/model I want to handle the idea.
- The idea is half-formed and I want to keep writing without starting a turn.

Today the composer is coupled to _sending_: to write the idea down I effectively
have to commit to a thread, a provider, and a model, and (for anything to
persist meaningfully) dispatch it. There's no first-class place to park a
provider-agnostic draft and decide later.

### Proposed solution

A **per-project idea queue** — a lightweight, offline, provider-agnostic inbox of
draft prompts/ideas scoped to a project:

- Write freely into the queue with no provider, model, or credits required, and
  no turn started. Drafts persist per project.
- Each queued item can carry attachments/context the composer already supports
  (images, file/terminal/element contexts) without being tied to a live session.
- Later, **promote** a queued item: choose the provider + model (+ effort /
  interaction mode) at submit time, which creates/opens a thread and dispatches
  it as a normal turn.
- Manage the queue: edit, reorder, delete, and ideally tag/title items.

**Key framing:** all the integration ideas below are the same primitive wearing
different clothes — an idea queue with an _open ingestion path_ and optional
_result write-back_. Build the queue so anything can push items in and read the
outcome, and external tools (Obsidian, GitHub, shortcuts, other agents) become
**thin adapters** rather than bespoke features. The design question is therefore
"what is the ingestion/write-back contract," then "which adapters ship first."

### Smallest useful scope

A per-project list of plain-text draft prompts you can add to without any
provider selected, and a "Send to…" action that opens the provider/model picker
and dispatches the draft into a new thread. Attachments, reordering, and tagging
are follow-ups.

### Design notes

- **Storage.** Drafts are provider-agnostic and must outlive any session, so they
  belong in the project's persisted state (server-side, alongside project /
  thread data in the orchestration store) rather than transient composer draft
  state. Reuse the existing composer-draft content model where possible so
  promotion re-hydrates attachments/contexts cleanly.
- **Decoupling from dispatch.** This reinforces the composer principle in
  [composer-turn-lifecycle.md](../architecture/composer-turn-lifecycle.md): input
  and drafting should never require an active turn, a chosen provider, or
  connectivity. An idea queue is the extreme case — drafting with _no_ provider
  at all.
- **Promotion = normal turn start.** Submitting a queued idea should funnel
  through the same `thread.turn.start` path as any message, with the queue item
  supplying the prompt + contexts; no special-case send path.
- **Relationship to "send while running."** A queue is the offline sibling of the
  queue/steer follow-up modes discussed for running turns
  ([#231](https://github.com/pingdotgg/t3code/issues/231)); worth keeping the UX
  vocabulary ("queue") consistent between the two.

### Integrations (pluggable sources & sinks)

Grouped by capture _mood_ — these are complementary, not redundant: private
free-form thinking vs. shareable actionable work vs. universal quick capture.

**Backbone (build these first — they make every adapter cheap):**

- **Watched drop-folder.** A per-project `ideas/` folder (or a configured vault
  subfolder) of markdown files. t3code reads/writes it; any external editor edits
  the same files. Bidirectional by construction — no API, no auth. This alone
  makes the Obsidian case essentially free.
- **Open ingestion endpoint.** t3code already exposes an **MCP server**
  (`mcp__t3-code__*`) and a WS/RPC API. Add an `enqueue idea` tool/endpoint so
  _anything_ can feed a project's queue: an Obsidian plugin, a shortcut, a
  webhook, or another agent. Build the queue against this contract and the
  adapters below are ~20 lines each.

**File-based adapter — Obsidian (the private-thinking end):**

- A vault is just a folder, so point the queue at a vault subfolder. Jump
  t3code → note via `obsidian://open?vault=…&file=…`; jump note → t3code via a
  t3code URL/protocol handler (desktop can register one) or an Obsidian button
  that writes into the drop-folder.
- Use frontmatter for metadata (`status: queued|dispatched`, `provider`,
  `model`, `project`). **Write-back:** append the turn's result to the source
  note, closing the loop ("bring an idea from notes → execute → answer lands back
  in notes").

**API-based adapter — GitHub Issues (the shareable-work end):**

- Ideas as issues with a `t3code-idea` label or a project-board column. t3code
  lists them and offers "dispatch this issue as a turn"; on completion it
  comments the result or opens a PR. This **compounds with t3code's existing
  branch/PR integration** — "issue in → turn → PR out" is a natural loop.
- Trade-off vs. Obsidian: issues are shareable, collaborative, actionable, and
  cross-device, but heavier and more public — great for "this is real work," bad
  for half-formed private thoughts. Different mood, not a duplicate.

**Quick-capture front-ends (low-friction entry the moment the idea strikes):**

- CLI verb `t3 idea add "…"` (the server CLI already has `project` / `auth`
  subcommands; an `idea` verb fits).
- OS layer: Raycast / Alfred command, macOS Shortcuts / share sheet, a global
  hotkey, or email-to-queue.
- Editor command: "Send selection to t3code idea queue" (VS Code / Zed /
  Obsidian).

**Task managers as the inbox:**

- Linear / Todoist / Things / Apple Reminders tagged `@t3code`; t3code pulls
  tagged items, dispatches, and marks them done on completion. Same pattern as
  GitHub Issues, different home.

**Recommended sequencing:** drop-folder + MCP/API enqueue endpoint (core) →
Obsidian (first file adapter) → GitHub Issues (first API adapter, reuses PR
machinery) → everything else as optional adapters.

### Open questions

- **Which adapters first?** Recommendation above (drop-folder + API, then
  Obsidian, then GitHub Issues) — confirm priority.
- **Conflict / sync semantics** for the drop-folder: t3code and Obsidian editing
  the same file concurrently — last-writer-wins, or a lightweight merge/lock?
- **Write-back placement:** append results into the source note/issue, or keep
  the t3code thread as the source of truth and only link back? Probably link +
  optional append.
- One flat queue per project, or per-thread queues too (park a follow-up against
  a specific conversation)?
- Should a queued item remember a _preferred_ provider/model (optional default)
  while still allowing a choice at submit time?
- Does an idea queue overlap enough with saved snippets
  ([#1547](https://github.com/pingdotgg/t3code/issues/1547)) to share a surface,
  or are they distinct (reusable snippets vs. one-shot deferred ideas)?

### Related

- Composer-must-stay-usable principle: [composer-turn-lifecycle.md](../architecture/composer-turn-lifecycle.md)
- Queue/steer follow-up modes: [#231](https://github.com/pingdotgg/t3code/issues/231)
- Saved snippets for frequent prompts: [#1547](https://github.com/pingdotgg/t3code/issues/1547)
