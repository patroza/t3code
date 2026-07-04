# Project Wishlist

Personal feature ideas for T3 Code, captured before they're ready to be filed
upstream or built. Each entry states the problem, a proposed shape, and the
smallest useful scope. Promote an entry to an upstream issue / implementation
when it's ripe.

---

## Per-project idea queue (deferred, provider-agnostic drafts)

**Status:** idea · **Area:** apps/web + apps/server (orchestration)

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

### Open questions

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
