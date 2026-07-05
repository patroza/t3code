# Worktree Multi-Agent Sessions

Reuse a git worktree/branch across multiple t3code threads and agents (e.g. start on Codex, continue on Cursor in a new session on the same checkout).

**Status:** Plan  
**Date:** 2026-07-05  
**Related:** Conductor-style workspace model, upstream [#3697](https://github.com/pingdotgg/t3code/issues/3697)

---

## Summary

Today t3code couples **thread ≈ conversation ≈ provider binding ≈ workspace**. A user who starts work in a worktree with Codex cannot easily open a **second thread on the same worktree** with Cursor. The git layer mostly supports this already (`worktreePath` on a thread skips `prepareWorktree`), but product UX, sidebar seeding, and navigation work against the workflow.

This plan introduces an explicit **“new agent session on this worktree”** flow, fixes new-thread seeding, and lays groundwork for worktree-first navigation and optional context handoff.

---

## Problem

### User story

1. Start a thread in **New worktree** mode with **Codex**.
2. Codex makes file changes on branch `t3code/abc123` under `~/.t3/worktrees/...`.
3. User wants a **new t3code session** on that **same worktree**, using **Cursor**, without creating another branch/worktree or losing git isolation.

### What fails today

| Gap | Detail |
|-----|--------|
| Provider lock per thread | Server rejects switching `codex` → `cursor` in the same thread (`ProviderCommandReactor`) |
| New thread UX | When `defaultThreadEnvMode === "worktree"`, sidebar “New thread” always seeds a **new** worktree, not the active one |
| No first-class worktree entity | `worktreePath` is thread metadata; no grouping or “+ session” affordance |
| No cross-agent handoff | Reusing cwd ≠ reusing provider resume cursor or native session history |
| Concurrent agents | No warning if two threads on same worktree run turns simultaneously |

---

## Current architecture

### Identity model

| Concept | Today | Implication |
|---------|-------|-------------|
| **Thread** | Messages + `modelSelection` + optional `session` + `branch` / `worktreePath` | One conversation, one provider resume state |
| **Worktree** | Optional fields on `OrchestrationThreadShell` | Not a durable workspace aggregate |
| **Provider session** | Per thread via `ensureSessionForThread` | Cannot change driver after start |

### Key code paths

**Provider lock (server)** — `apps/server/src/orchestration/Layers/ProviderCommandReactor.ts`:

- Rejects `currentInfo.driverKind !== desiredInfo.driverKind` after thread has started.
- Rejects incompatible `continuationIdentity.continuationKey` across provider instances.

**Worktree creation (client)** — `apps/web/src/components/ChatView.tsx`:

- `prepareWorktree` runs only when first message, `sendEnvMode === "worktree"`, and `!activeThread.worktreePath`.
- If `worktreePath` is already set, send uses that cwd — **reuse primitive exists**.

**New thread seeding (sidebar)** — `apps/web/src/components/Sidebar.logic.ts`:

- If default env is `worktree`, returns `{ envMode: "worktree" }` only — **does not inherit** active thread’s `worktreePath`.
- If default env is `local`, inherits active thread `branch` + `worktreePath`.

**Thread create (server)** — `packages/contracts/src/orchestration.ts`:

- `ThreadCreateCommand` and bootstrap already accept `branch` + `worktreePath`.

### Partial workaround today

1. Set `defaultThreadEnvMode` to **`local`**.
2. Focus Codex worktree thread → **New thread** (sidebar seeds `branch` + `worktreePath`).
3. Select **Cursor** before first send.
4. Send — no second worktree created.

Fragile: easy to miss step 1; no handoff; no worktree grouping.

---

## Target mental model

```
Project
 └── Worktree workspace (branch + path)     ← git isolation unit
      ├── Thread A — Codex session        ← chat + provider resume
      ├── Thread B — Cursor session
      └── Thread C — plan-only / human
```

- **Worktree workspace** = shared checkout (branch, path, diffs, optional shared checkpoints view).
- **Thread** = agent session + transcript + provider-specific resume cursor.
- Multiple threads may reference the same `worktreePath`; each chooses its provider **before first send**.

Aligns with Conductor ([#3697](https://github.com/pingdotgg/t3code/issues/3697), draft PR [#2708](https://github.com/pingdotgg/t3code/pull/2708)).

---

## Implementation plan

### Deployment surfaces

This feature should be implemented at the shared web/orchestration layer, not as a desktop-only bridge feature.

Supported surfaces:

- **Local desktop client**: desktop shell renders `apps/web` against the local environment server.
- **Mobile web browser → local server**: browser renders the same `apps/web` UI and dispatches to the local environment over HTTP/WebSocket.
- **Laptop desktop client → remote/smart server**: desktop shell connects to a secondary/remote environment and dispatches the same orchestration commands scoped by `environmentId`.
- **Mobile web browser → remote/smart server**: browser connects to the remote environment over HTTP/WebSocket and uses the same server-side thread/worktree metadata.

Implementation rule:

- Put seed/grouping behavior in `apps/web` and shared client-runtime helpers where possible.
- Keep worktree creation/validation on the target environment server. The client must not assume the local desktop filesystem when the selected `environmentId` points at a remote server.
- Always derive project/thread context from `ScopedProjectRef` / `ScopedThreadRef`; never from a process-global "local" project.
- Treat `worktreePath` as opaque display/identity data from the target environment. Use it for grouping and command payloads, but only the target server should validate or operate on it.
- The seed-only MVP works across local and remote environments because it only copies existing `branch` + `worktreePath` from a thread in the same project/environment into a new draft for that same project/environment.

### Phase 0 — Seed-only MVP

**Goal:** Unblock same-worktree multi-agent sessions today without introducing a new durable data model or protocol shape.

The existing model is already sufficient for a narrow first cut:

- Draft/server threads already carry `branch` + `worktreePath`.
- `thread.turn.start` bootstrap `createThread` already accepts `worktreePath`.
- `ChatView` only sends `prepareWorktree` when creating a new worktree; a draft with an attached `worktreePath` can start in that checkout without calling `gitWorkflow.createWorktree`.

#### Web UI

- Update `resolveSidebarNewThreadSeedContext` so a matching active thread or draft with `worktreePath` wins even when `defaultThreadEnvMode === "worktree"`.
- Seed the new draft with:

```ts
{
  branch,
  worktreePath,
  envMode: "local",
}
```

`envMode: "local"` is intentional: it means "use the attached checkout" for this draft, not "create a new worktree on first send."

#### Tests

| Area | Cases |
|------|-------|
| `Sidebar.logic.test.ts` | Active server thread with `worktreePath` + default worktree mode → inherit path + branch, `envMode: "local"` |
| `Sidebar.logic.test.ts` | Active draft thread with `worktreePath` + default worktree mode → inherit path + branch, `envMode: "local"` |
| Web environment scoping tests | Same-worktree seed only when active thread/draft matches the target `projectId` and environment-scoped project ref |
| Existing send/bootstrap tests | Rely on current coverage that `createThread.worktreePath` is persisted and no `prepareWorktree` runs unless requested |

#### Acceptance criteria

- From Codex thread on `~/.t3/worktrees/my-repo/feature-x`, user creates a new thread in the same project.
- The draft starts with the same `branch` + `worktreePath`.
- User picks Cursor before first send.
- Provider cwd = existing worktree path.
- No new branch/worktree is created.
- Codex thread unchanged.

#### Recovery / upstream compatibility

- This is easily recoverable if upstream lands a first-class Conductor-style workspace model: existing data can be grouped or migrated by canonical `worktreePath`.
- No DB table, event type, or provider resume semantics are committed in this MVP.
- If upstream changes the workspace model, the fallback is to reinterpret these threads as sessions attached to a workspace derived from their existing `worktreePath`.

### Phase 1 — Explicit “New agent session on this worktree”

**Goal:** One explicit action from an existing worktree thread → new draft/thread with same `branch` + `worktreePath`, any provider, no `prepareWorktree`.

#### Web UI

- Add actions on worktree threads (thread menu, git toolbar, or worktree header):
  - **New agent session here**
  - Optional: **Continue with another agent…** (same + provider picker)
- Implementation: call `handleNewThread(projectRef, { branch, worktreePath, envMode: "local" })`.
  - Use `local` env mode to avoid accidental second worktree when project default is `worktree`.
- Update `resolveSidebarNewThreadSeedContext`:
  - Phase 0 already makes the default new-thread action inherit an attached worktree.
  - This phase can add explicit affordances that distinguish:
    - **New worktree**
    - **Same worktree, new session** (inherit path + branch, `envMode: "local"`)

#### Mobile

- Mirror in new-task flow: when viewing a worktree thread, offer **New session on this worktree** (reuse `selectedWorktreePath` + branch, skip `prepareWorktree`).

#### Server / contracts (defer unless needed)

The seed-only MVP does not require a new bootstrap attach path. Add one later only if we need to attach arbitrary external worktrees with server-side validation before first send.

Possible future shape:

```ts
// packages/contracts/src/orchestration.ts
const ThreadTurnStartBootstrapAttachWorktree = Schema.Struct({
  worktreePath: TrimmedNonEmptyString,
  branch: TrimmedNonEmptyString,
});

// ThreadTurnStartBootstrap.attachWorktree?: ...
```

Server behavior in `apps/server/src/ws.ts` bootstrap handler:

1. Validate `worktreePath` is a git worktree for the project root.
2. Validate branch matches worktree checkout (or resolve via `git worktree list`).
3. Dispatch `thread.meta.update` with `branch` + `worktreePath`.
4. **Do not** call `gitWorkflow.createWorktree`.

Reject if path is main checkout when user intended isolated worktree, or branch is locked elsewhere (reuse GitManager invariants from PR prep).

#### Tests

| Area | Cases |
|------|-------|
| `Sidebar.logic.test.ts` | Explicit same-worktree action → same-worktree seed |
| `server.test.ts` | Bootstrap attach sets cwd; no `createWorktree` call |
| `ChatView` send | Pre-set `worktreePath` → no `prepareWorktree` in bootstrap |

**Acceptance criteria**

- From Codex thread on `~/.t3/worktrees/my-repo/feature-x`, user creates new session, picks Cursor, sends prompt.
- Provider cwd = existing worktree path.
- No new branch/worktree created.
- Codex thread unchanged.

---

### Phase 2 — Worktree-first navigation

**Goal:** Manage multiple sessions per worktree without mental overload.

- Land sidebar **group by worktree** ([#3697](https://github.com/pingdotgg/t3code/issues/3697), [#2708](https://github.com/pingdotgg/t3code/pull/2708)).
- Per worktree group header: **+ New session** (Phase 1 flow).
- Thread rows: provider badge + optional “session” label (extend [#3057](https://github.com/pingdotgg/t3code/pull/3057)).
- Optional worktree display labels ([#3070](https://github.com/pingdotgg/t3code/pull/3070)).

#### Data model (lightweight v1)

- Client-side `WorktreeGroupKey = canonical(worktreePath) | "local:<branch>"`.
- Derive groups from `OrchestrationThreadShell[]` + git status.
- Defer DB `worktree_workspace` table until lifecycle/spotlight needs it.

#### Non-durable grouping MVP

This can be shipped without a durable `worktree_workspace` table:

- In each project group, partition visible threads by canonical `worktreePath`.
- Only render a subgroup when more than one thread references the same canonical worktree path.
- Keep single-thread worktrees as normal rows to avoid extra sidebar noise.
- Label subgroup headers from the worktree basename plus branch when available.
- Put **+ New session** on the subgroup header; it calls the Phase 0 seed path with that group’s `branch` + `worktreePath`, `envMode: "local"`.
- Treat `null` worktree paths as the main checkout group and do not subgroup them unless a later design wants local-session grouping.
- Keep grouping scoped to a single environment/project. Identical path strings from different remote environments must not collapse together.

This matches the Conductor mental model while remaining ephemeral: a restart or upstream migration can rebuild the same groups from thread shells.

---

### Phase 3 — Context handoff (optional)

Reusing the **directory** is not reusing the **agent session**. Options:

| Strategy | Effort | Fidelity | Recommendation |
|----------|--------|----------|----------------|
| A. Empty new thread | None | None | OK for greenfield continuation |
| B. Fork messages from point N | Medium | Medium | Reuse [#1404](https://github.com/pingdotgg/t3code/issues/1404) pattern |
| C. Handoff artifact (summary + files + open questions) | Medium | Good cross-provider | **Preferred for Codex→Cursor** |
| D. Native resume bridge | Very high | Poor cross-driver | **Do not pursue** ([#2365](https://github.com/pingdotgg/t3code/issues/2365)) |

**Handoff flow (C):**

1. User chooses **Continue with Cursor…** on Codex thread.
2. Create new thread (Phase 1) + inject first user message from template:
   - Branch, worktree path, files changed (from turn diffs), last plan artifact, open questions.
3. Do not pass Codex `resume_cursor` to Cursor.

---

### Phase 4 — Safety and shared artifacts

- **Concurrent turn warning** if another thread with same `worktreePath` has active provider session (`session.status !== "stopped"`).
- Optional **exclusive session** setting per worktree (future).
- **Diff/checkpoint view:** optional worktree-scoped aggregation across threads (checkpoints remain per-thread initially).
- **Env vars:** `T3CODE_WORKTREE_PATH`, `T3CODE_THREAD_ID`, `T3CODE_PROJECT_ID` ([#3003](https://github.com/pingdotgg/t3code/issues/3003), PR [#3004](https://github.com/pingdotgg/t3code/pull/3004)) for automation spawning sibling sessions.

---

## PR sequence

| PR | Scope | Risk |
|----|-------|------|
| **A** | Seed-only MVP + sidebar tests | Low |
| **B** | Non-durable worktree subgrouping + per-worktree “+ session” | Medium (UI/state) |
| **C** | Optional attach validation/protocol if external worktree attach needs it | Medium |
| **D** | Handoff artifact (optional) | Medium |
| **E** | Concurrency warning + docs | Low |

---

## Open decisions

1. **Concurrent agents:** warn only, or block second active session on same worktree?
2. **Handoff default:** empty thread vs auto-inject summary?
3. **UI naming:** “session” vs “thread” to avoid confusion with provider `session`?
4. **Checkpoints:** per-thread only, or shared worktree timeline?

---

## Related upstream issues and PRs

### Worktree reuse / multi-session

| ID | Title | Notes |
|----|-------|-------|
| [#3697](https://github.com/pingdotgg/t3code/issues/3697) | Group threads by worktree | Primary UX; Conductor model |
| [#2708](https://github.com/pingdotgg/t3code/pull/2708) | Sidebar worktree grouping (DRAFT) | “New threads in specific worktrees” called out as follow-up |
| [#1830](https://github.com/pingdotgg/t3code/issues/1830) | defaultThreadEnvMode reuses worktree (CLOSED) | Opposite bug — one worktree per project confusion |
| [#1714](https://github.com/pingdotgg/t3code/issues/1714) | External worktrees treated as Local | Attach must recognize existing worktrees |
| [#1047](https://github.com/pingdotgg/t3code/issues/1047) | Worktree doesn’t open selected branch | Selection correctness |
| [#3653](https://github.com/pingdotgg/t3code/issues/3653) | Stale branch sync clears worktree path | Risk for attach flow |
| [#525](https://github.com/pingdotgg/t3code/issues/525) | Spotlight mode | Test shared worktree from main checkout |
| [#417](https://github.com/pingdotgg/t3code/issues/417) | Spawn from PR/issue/branch | Starting point → N sessions |
| [#3003](https://github.com/pingdotgg/t3code/issues/3003) | Thread env vars | Automation |
| [#3004](https://github.com/pingdotgg/t3code/pull/3004) | Unify launch env | Same |

### Provider switching (same thread — out of scope)

| ID | Title | Notes |
|----|-------|-------|
| [#2365](https://github.com/pingdotgg/t3code/issues/2365) | Switch Claude-compatible providers (CLOSED) | Resume incompatible across instances |
| [#3604](https://github.com/pingdotgg/t3code/issues/3604) | OpenCode loses thread on follow-up | Session binding |
| [#3617](https://github.com/pingdotgg/t3code/pull/3617) | OpenCode resume fix | Same class |
| [#3149](https://github.com/pingdotgg/t3code/issues/3149) | Cursor resume replays history | Dedup if copying messages |
| [#3642](https://github.com/pingdotgg/t3code/pull/3642) | Cursor resume message order | Cursor fragility |

### Fork / delegation / import

| ID | Title | Notes |
|----|-------|-------|
| [#1404](https://github.com/pingdotgg/t3code/issues/1404) | Fork thread from message | Handoff pattern |
| [#538](https://github.com/pingdotgg/t3code/issues/538) | Subagent nested threads | Multi-agent |
| [#3138](https://github.com/pingdotgg/t3code/issues/3138) | Orchestration/Delegation | Long-term |
| [#2304](https://github.com/pingdotgg/t3code/issues/2304) | Plans as artifacts (CLOSED) | Handoff via plan |
| `importSessions` | Import external agent sessions | Similar attach-workspace pattern |

### Worktree infra

| ID | Title |
|----|-------|
| [#272](https://github.com/pingdotgg/t3code/issues/272), [#3651](https://github.com/pingdotgg/t3code/issues/3651) | Branch naming |
| [#1878](https://github.com/pingdotgg/t3code/issues/1878), [#1926](https://github.com/pingdotgg/t3code/pull/1926) | Worktree location |
| [#3034](https://github.com/pingdotgg/t3code/pull/3034) | Worktree housekeeping |
| [#3593](https://github.com/pingdotgg/t3code/issues/3593) | Cleanup timeouts |
| [#2868](https://github.com/pingdotgg/t3code/pull/2868), [#2864](https://github.com/pingdotgg/t3code/pull/2864) | Git context fixes |

---

## Files likely touched (Phase 1)

| File | Change |
|------|--------|
| `apps/web/src/components/Sidebar.logic.ts` | Seed context for same-worktree |
| `apps/web/src/components/Sidebar.logic.test.ts` | Seed context regression tests |
| `apps/web/src/components/Sidebar.tsx` | Optional non-durable subgrouping and “+ New session” action |
| `apps/web/src/hooks/useHandleNewThread.ts` | Optional attach preset if needed by UI wiring |
| `apps/web/src/components/ChatView.tsx` | Optional “New session here” action |
| `apps/mobile/src/features/threads/new-task-flow-provider.tsx` | Mobile parity |
| `*.test.ts` | Sidebar seed tests; server bootstrap tests only if adding attach validation |

---

## Verification

```bash
vp check
vp run typecheck
vp test
# Focused:
vp run test -- Sidebar.logic.test.ts
vp run test -- server.test.ts  # bootstrap attach cases
```

Manual:

1. Create Codex worktree thread; complete one turn.
2. Use **New agent session here** → Cursor → send.
3. Confirm same cwd in provider logs, no `git worktree add`.
4. Confirm Codex thread still resumable independently.
