# Discord bot: restore thread bridges after restart

**Status:** implemented (boot + T3 reconnect rehydrate)
**Branch context:** Discord bot restore bridges on start
**Non-goals for implementers:** do not deploy/restart microVM or host services as part of this design work unless explicitly asked later.

## Problem

After the Discord bot process restarts (or the T3 WebSocket session is replaced):

- Durable **Discord ↔ T3** links already exist in `links.json`.
- **Live** T3 `subscribeThread` bridges and in-memory stream state do **not**.
- In-flight turns go silent on Discord until a human `@mention`s again.
- Completed turns that finished while the bot was down may never get a Discord final post.

Mentions still **continue** the same T3 thread (lookup works). What is missing is **automatic re-attach + catch-up finalize**.

## Goals

1. On bot boot (and T3 reconnect), re-establish bridges for the right set of links.
2. If a turn finished offline, run the **normal finalize path**: remove in-progress stream tips (from **stored ids only**), post final answer + `stream-history.md` as today.
3. Cap concurrent bridges; prefer freshest activity.

## Non-goals (v1)

- Multi-bot HA / shared remote DB.
- Scanning arbitrary Discord threads for `_Working.._` outside stored stream message ids.
- Restoring idle historical links “just in case.”
- Perfect recovery of Discord message identity when stream tip ids were never persisted.

---

## Locked decisions

| #   | Decision                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Restore set:** only threads that are **running** or **pending** (approval / user-input). Not idle/recent-by-default.                                                                                               |
| 2   | **Missed finalize:** **auto-post** to Discord using the usual pipeline — find previous in-progress messages for that turn (via **stored** tip/stale ids), replace with final message(s) + stream-history transcript. |
| 3   | **Orphan cleanup:** **only stored stream message ids**. Do not scan other channels/threads for Working.. markers.                                                                                                    |
| 4   | **Cap:** max **50** concurrent bridges. When over capacity, **drop oldest by `lastActivityAt`** (do not restore / evict ensure).                                                                                     |

---

## Current building blocks

| Piece                | Location                                                                          | Notes                                                   |
| -------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Link store           | `apps/discord-bot/src/store/ThreadLinkStore.ts`                                   | `$T3_DISCORD_BOT_DATA_DIR/links.json`                   |
| Link fields today    | `discordThreadId`, `t3ThreadId`, `projectId`, `channelId`, `guildId`, `createdAt` | Written on first worktree turn                          |
| Bridge entry         | `bridgeThreadToDiscord` in `ResponseBridge.ts`                                    | In-memory `bridgeFibers` only                           |
| Adopt-without-repost | `adoptedInitialSnapshot` in bridge                                                | Avoids re-posting completed answers on re-subscribe     |
| Finalize             | `finalizeAssistantMessage`                                                        | Create final + delete stream tip ids; stream-history.md |

Guest path today: `/var/lib/t3/discord-bot/links.json`.

---

## Architecture

```
main.ts boot / T3 reconnect
        │
        ▼
  ThreadLinkStore.list()
        │
        ▼
  selectCandidates(running | pending)
        │
        ▼
  rank by lastActivityAt desc, take ≤ 50
        │
        ▼
  BridgeHub.ensure(link)  ──singleflight per discordThreadId──►
        │
        ├── subscribeThread(t3ThreadId)
        ├── snapshot: turn running? → resume stream tips (new tip if needed)
        └── snapshot: turn complete + not finalized on Discord?
                → finalize (delete stored openStreamMessageIds, post final + transcript)
```

**Link** = durable mapping.
**Bridge** = live fiber + ephemeral Discord stream state.
Boot/reconnect turns links → bridges for the selected subset only.

---

## Data model (links.json v2)

Version the document so old arrays still load.

```json
{
  "version": 2,
  "links": [
    {
      "discordThreadId": "string",
      "t3ThreadId": "string",
      "projectId": "string",
      "channelId": "string",
      "guildId": "string",
      "createdAt": "ISO-8601",
      "updatedAt": "ISO-8601",
      "lastActivityAt": "ISO-8601",
      "status": "active",
      "lastSeenTurnId": null,
      "lastFinalizedAssistantId": null,
      "openStreamMessageIds": []
    }
  ]
}
```

| Field                        | Purpose                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `lastActivityAt`             | Eviction order; touch on mention, bridge event, put                                            |
| `status`                     | `active` \| `tombstone` (missing Discord/T3 thread)                                            |
| `lastSeenTurnId`             | Correlate turn for catch-up finalize                                                           |
| `lastFinalizedAssistantId`   | Skip re-finalizing the same assistant bubble                                                   |
| `lastThreadSnapshotSequence` | Orchestration cursor for performant `subscribeThread({ afterSequence })` resume                |
| `lastDeliveredSequence`      | Advances only after Discord delivery succeeds; lag vs orchestration triggers catch-up          |
| `openStreamMessageIds`       | Discord message ids for in-progress tips (+ stale tips). **Only** these are deleted on cleanup |

**Migration:** if file is a bare array (v1), wrap as `{ version: 2, links: [...] }` and default `lastActivityAt = createdAt`, empty stream ids, `status: active`.

**Store API additions:**

- `getByT3ThreadId`
- `touch(discordThreadId, at?)`
- `tombstone(discordThreadId)`
- `updateBridgeHints(discordThreadId, partial)` — stream ids, last finalized assistant, lastSeenTurnId
- Atomic write: temp file + rename; mode `0o600`

---

## BridgeHub

Extract from ad-hoc `bridgeFibers` in `ResponseBridge.ts`.

| Method                  | Behavior                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ensure(link, opts?)`   | Singleflight per `discordThreadId`. If live fiber exists, no-op (or replace if `t3ThreadId` changed). Starts `runBridge`.              |
| `drop(discordThreadId)` | Interrupt fiber; clear memory only (keep durable link).                                                                                |
| `listActive()`          | Ops / alerts                                                                                                                           |
| Cap enforcement         | Before ensure beyond 50: drop active bridges with oldest `lastActivityAt` among **active fibers**, or skip restore of older candidates |

`bridgeThreadToDiscord` becomes a thin wrapper around `BridgeHub.ensure` (callers: MentionRouter, boot rehydrate, T3 reconnect).

**Opts (v1):**

- `workingAckMessageId?` — only from mention path
- `mode: "interactive" | "rehydrate"` — rehydrate skips posting a new Working.. unless turn is running and no tip exists

---

## Candidate selection (decision 1)

For each `status === active` link:

1. Resolve T3 thread from shell / thread detail (skip + tombstone if missing).
2. Resolve Discord channel (GET); on 404 tombstone.
3. Include if **any** of:
   - `latestTurn.state === "running"` (or equivalent “in progress”)
   - pending approval(s) on the thread
   - pending user-input request(s)
4. Exclude idle completed threads (they restore **lazily** on next `@mention` via existing link lookup).

Sort included candidates by `lastActivityAt` **descending**.
Take first **50**. Log dropped count.

---

## Catch-up finalize (decision 2 + 3)

When rehydrate snapshot shows:

- Turn **not** running, and
- There is a completed assistant answer for the last user turn, and
- `assistant.id !== lastFinalizedAssistantId` (or open stream ids still present / never finalized),

then run the **same** finalize path as live turns:

1. Load `openStreamMessageIds` from the link (and any in-memory state if fiber just started).
2. **Delete only those ids** (decision 3) — no channel-wide Working.. scan.
3. Post final answer text (use existing `finalAnswerText` / finalize rules) + attachments.
4. Attach `stream-history.md` from accumulated progress text when available (from T3 messages this turn if stream text was not in memory).
5. Persist `lastFinalizedAssistantId`, clear `openStreamMessageIds`, `touch` link.

If turn is **still running**:

- `ensure` bridge, adopt snapshot, open/edit a stream tip if needed.
- Prefer reusing stored tip ids when still editable and latest; else create a new tip and **append** id to `openStreamMessageIds` (leave old ids listed so finalize still deletes them).
- Do not invent tips in unrelated threads.

**Transcript source when process memory is empty:** reconstruct from T3 thread messages after last user message (same as `turnProgressText`), not from Discord history scraping.

---

## Boot sequence

```
1. DiscordBotRunning / gateway up
2. t3.connect()
3. migrate links.json if needed
4. candidates = select running|pending
5. sort by lastActivityAt desc; cap 50
6. for each candidate (concurrency 3–5):
     BridgeHub.ensure(link, { mode: "rehydrate" })
7. log: restored / failed / tombstoned / capped-out
8. Effect.never (existing)
```

Do **not** restart microVM or host units for this feature.

---

## T3 WebSocket reconnect

When `T3Session` replaces the session (existing pattern clears thread fibers):

1. Interrupt / clear BridgeHub fibers (or they die with subscribe).
2. Re-run the **same** candidate selection + ensure (running|pending, cap 50).
3. Catch-up finalize again if turns completed during the outage.

---

## Mention path (unchanged contract)

- Resolve link by Discord thread id.
- `touch` + `BridgeHub.ensure` + `startTurn` as today.
- On first link create, `put` full record with `lastActivityAt = now`.
- While streaming, bridge **must** persist `openStreamMessageIds` (and stale tip ids) on each tip create/displace so restart cleanup works (decision 3).

---

## Eviction (decision 4)

- **Hard cap:** 50 concurrent **active bridges**.
- When selecting restores: only top 50 by `lastActivityAt`.
- If an interactive mention needs a bridge while at 50:
  - Prefer evicting the active bridge with oldest `lastActivityAt` that is **not** running/pending; if all 50 are running/pending, log error / alert and still ensure the mentioned thread (or refuse with a Discord error — **prefer ensure mentioned thread** and drop oldest non-critical).
- Evict = `drop` fiber only; **keep** durable link.

Suggested priority for forced eviction: idle completed bridges first; never evict `running` or pending-approval if avoidable.

---

## Failure modes

| Case                               | Handling                                                          |
| ---------------------------------- | ----------------------------------------------------------------- |
| Discord thread deleted             | Tombstone link; skip                                              |
| T3 thread missing                  | Tombstone link; skip                                              |
| Subscribe timeout                  | Log + ops alert; leave link active for next mention               |
| Finalize fails (Discord 4xx/5xx)   | Log + alert; keep `openStreamMessageIds` for retry on next ensure |
| Corrupt links.json                 | Load empty / backup; do not crash bot                             |
| Stream ids stale (already deleted) | Delete is best-effort (ignore 404); clear hints after attempt     |

---

## Implementation PRs

### PR1 — Store v2 + BridgeHub shell

- Versioned links schema + migration
- `getByT3ThreadId`, `touch`, `tombstone`, `updateBridgeHints`
- `BridgeHub` with singleflight `ensure` / `drop` / cap stub
- Wire MentionRouter to Hub without behavior change
- Tests: migrate v1→v2, put/get/touch

### PR2 — Persist stream message ids

- Bridge writes `openStreamMessageIds` (+ stale) on tip create/displace/clear on finalize
- Tests: hints updated; finalize clears

### PR3 — Boot + reconnect rehydrate

- `selectCandidates(running|pending)`
- Cap 50 by `lastActivityAt`
- `main.ts` after connect; T3 session replace hook
- Catch-up finalize when turn complete and not yet finalized
- Integration-style tests with fakes

### PR4 — Eviction polish + alerts

- Cap eviction policy
- Ops alert on rehydrate failures / finalize retry exhaustion
- Docs: `docs/integrations/discord-bot.md` short section

---

## Success criteria

1. Bot killed mid-turn → start bot → Discord stream resumes or finalizes **without** a new `@mention`.
2. Turn completed while bot down → on boot, Discord gets **one** final post + transcript; stored tip ids removed; **no** duplicate finals on second restart.
3. Idle linked threads: no bridge until next mention; mention still continues T3 thread.
4. Never deletes messages outside `openStreamMessageIds` for that link.
5. ≤ 50 bridges; overflow prefers freshest `lastActivityAt`.
6. T3 WS reconnect re-applies the same restore rules.

---

## File touch map (expected)

| Path                                              | Change                                                  |
| ------------------------------------------------- | ------------------------------------------------------- |
| `apps/discord-bot/src/store/ThreadLinkStore.ts`   | v2 schema, migration, new APIs                          |
| `apps/discord-bot/src/features/BridgeHub.ts`      | new                                                     |
| `apps/discord-bot/src/features/ResponseBridge.ts` | hub integration, persist stream ids, rehydrate finalize |
| `apps/discord-bot/src/features/MentionRouter.ts`  | ensure via hub, touch                                   |
| `apps/discord-bot/src/t3/T3Session.ts`            | reconnect callback / re-ensure hook                     |
| `apps/discord-bot/src/main.ts`                    | boot rehydrate                                          |
| `apps/discord-bot/src/**/*.test.ts`               | store, hub, candidate selection                         |
| `docs/integrations/discord-bot.md`                | operator-facing restore notes                           |

---

## Out of scope reminders

- Do not depend on Honeycomb/Sentry for restore logic.
- Do not scan guild history for orphan Working.. messages.
- Do not restore all historical links by default.
