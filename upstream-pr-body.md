## The problem

`refreshThreadShellSummary` loads every activity row a thread has ever produced — payloads included — to compute a single integer, `pendingUserInputCount`.

Activity payloads are the tool timeline, so the cost of one refresh scales with the thread's entire history. Across the 402 threads on a heavily-used instance, comparing what the refresh reads against what the derivation needs:

| thread | rows read | of which needed | bytes read | of which needed |
| ------ | --------- | --------------- | ---------- | --------------- |
| median | 277       | 0               | 2.8 MB     | 0               |
| p95    | 1,190     | 0               | 60.4 MB    | 0               |
| p99    | 4,279     | 0               | 123.0 MB   | 0               |
| max    | 11,137    | 0               | 493.3 MB   | 0               |

The "needed" column is zero for 397 of 402 threads, and that is not a quirk of this dataset: `pendingUserInputCount` derives only from `user-input.requested`, `user-input.resolved` and `provider.user-input.respond.failed`, which exist only when a provider stops mid-turn to ask the user something. Even on the 5 threads here that _have_ had one, they account for **2–4 rows out of thousands** — 1.3 KB out of 3.5 MB on the largest.

So the read is not merely oversized on one unusual thread; it is reading the whole timeline to find a handful of rows that are usually not there at all.

## This is already reported

- **#5719** — _Assistant streaming causes full-thread projection scans for every text delta_ — names `refreshThreadShellSummary` and this exact reload.
- **#4597** — _Headless nightly server crashes with JavaScript heap out of memory after ~23.5 hours_ — the symptom. That report died at ~23.5 h; on the instance measured here, systemd recorded a 25 h run peaking at **31.8 G** with **28.8 G read from disk**, and shorter runs at 32.4 G and 36.8 G against a raised `--max-old-space-size`. At the cap the process sits in back-to-back full GCs and every connected client stalls until it is restarted.
- On #5719, `dain` also observed cross-thread head-of-line blocking: one busy thread delaying unrelated turns for minutes. That matches what this looks like from a client — everything slow, not one screen.

## How this relates to #5855 and #6608

Both of those reduce **how often** the refresh runs. This PR reduces **what it costs when it runs**. They compose; none of them replaces another:

|                                           | #5855 | #6608 | this PR |
| ----------------------------------------- | ----- | ----- | ------- |
| Skip refresh for assistant deltas         | ✅    | ✅    | —       |
| Skip refresh for streaming activity kinds | —     | ✅    | —       |
| Make the remaining refreshes cheap        | —     | —     | ✅      |

Neither #5855 nor #6608 changes the read itself — both still call `projectionThreadActivityRepository.listByThreadId({ threadId })` and pull the full payload set. With either merged, every _lifecycle_ event (`user-input.requested/resolved`, approval events, proposed-plan upserts, `thread.session-set`, `thread.turn-diff-completed`) still pays the whole-thread read. On the instance above that is up to 467 MB per event, for one integer.

Merging this alongside them means the refreshes that remain are also cheap. If the maintainers prefer #6608's shape, this still applies unchanged on top of it — the two touch different lines.

## The change

`derivePendingUserInputCountFromActivities` only reacts to three kinds — `user-input.requested`, `user-input.resolved` and `provider.user-input.respond.failed` — and `continue`s past everything else. The read now filters on exactly those three, with the kinds declared next to the deriver so the two stay in step.

Measured against the same database. The busiest thread, warm, before schema decode and the sort that follows:

```
before:  10,652 rows      467.4 MB     348.8 ms
after :       0 rows        0.000 MB       6.9 ms
```

And on the threads where the filtered read is _not_ empty — the fix's worst case:

```
3,778 rows / 3.5 MB → 2 rows / 1.3 KB     7.3 ms → 1.9 ms
1,576 rows / 1.8 MB → 3 rows / 1.3 KB     2.3 ms → 0.8 ms
1,226 rows / 1.6 MB → 2 rows / 1.4 KB     1.9 ms → 0.6 ms
```

Deployed, the traced projection step moved:

```
applyThreadsProjection   p50 1,707 ms → 1.5 ms     p95 4,814 ms → 17.4 ms     max 15,010 ms → 35.1 ms
```

94% of orchestration events there reach this path (`thread.activity-appended` alone), averaging ~356/hour and peaking at 2,613 in one hour.

`ProjectionThreadActivityRepository` gains `listByThreadIdAndKinds`, which reuses the row decoding of `listByThreadId`, keeps its exact ordering, and short-circuits an empty kind list without issuing a query. `listByThreadId` is unchanged and still used everywhere else.

No behaviour change: the rows removed from the read are ones the deriver already skipped.

## Why it went unnoticed for so long

The code landed in #1973 (2026-04-13) and has not been touched in the 1,239 commits since. It only bites at the tail — on the instance measured, the median thread holds 306 activity rows (~2.8 MB), which is unnoticeable; the p99 holds 4,279 rows / 123 MB. It needs long-lived threads _and_ a server process that stays up for days, which is not the common desktop profile.

Adjacent fixes have repeatedly addressed the same underlying volume on the **serve** path — #4622 pruning activity payloads over the wire, #4788 gzipping snapshots, #5482 dropping MCP tool results from thread payloads, #5147 bounding catch-up replay. This is the same volume problem on the **projection** path.

## Tests

Five repository tests cover kind filtering, ordering parity with the unfiltered list, payload-decoding parity, thread isolation, and the empty-kinds short circuit.

One `ProjectionPipeline` test is added, because the existing suite could not catch the failure mode this change introduces. The suite asserted `pendingUserInputCount` only where it settles back to `0`, so a filter that dropped every row would still have passed. The new test appends a `user-input.requested` activity alongside unrelated tool noise and asserts the count is **1**.

Verified by mutation: renaming the filtered kinds makes only the new test fail — the other 22 in that file still pass.

Equivalence was also checked against real data. Replaying the deriver over all 402 threads on the instance above, once from the full activity list and once from the filtered list, produced identical counts for every thread.

Not a UI change, so no screenshots.

---

Written by Claude Opus 5 in Claude Code.

Co-authored-by: Patrick Roza <42661+patroza@users.noreply.github.com>
