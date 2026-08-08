# NTBS skeleton adversarial review

**Status:** review of the declaration-phase skeleton in `apps/server/src/ntbs`

**Scope:** `schemas.ts`, `processor.ts`, `platform-handler.ts`, `adapter.ts`, reviewed against [ntbs.md](./ntbs.md), [ntbs-architecture.md](./ntbs-architecture.md), [ntbs-event-processing.md](./ntbs-event-processing.md), [ntbs-plan.md](./ntbs-plan.md), and the existing implementation (`apps/server/src/jira`, `apps/server/src/github`, `apps/server/src/ws.ts`, `apps/server/src/orchestration`, `packages/contracts`).

## Verdict

The core seam is right — a shared lifecycle processor with per-platform adapters is exactly what `JiraIssueBridge` and `GitHubPrBridge` already share informally (they import each other's outcome-resolution helpers), and thread-per-event kills the hairiest logic in the current bridges (thread reuse, turn targeting against a shared thread). But the skeleton as declared has **two liveness holes that make it unimplementable as specified**, quietly **regresses five capabilities the current bridges already have**, **re-declares a mechanic the codebase already ships** (turn-start bootstrap), and carries at least three abstractions that can be deleted.

Findings are ordered by severity within each section and numbered globally for reference.

## A. Decisions to make now (cheap in planning, expensive later)

- **Snapshot retention.** Adapters persist external user content (snapshots) indefinitely; platforms let users delete messages. The docs punt to adapters — fine, but record it as a known compliance question, and note the current store's ~2000-record cap as prior art.

## What is right (keep it)

- Thread-per-event genuinely deletes the worst code in the current bridges (`resolveLinkedThreadId`, ambiguous-link handling, target-turn discovery against shared threads).
- The adapter surface (`accept`/`save`/`find`/`post*`) is small, in-memory-fakeable, and matches the plan's testing strategy.
- Keeping platform data opaque-generic (`PlatformData<Source, ResponseDestination>`) while the processor owns sequencing is the correct division — every platform-independent behavior identified in the Jira bridge analysis fits it once findings 1–5 are fixed.

## Summary

The skeleton is a good shape wrapped around an incomplete failure model:

1. Fix the recovery story (findings 1, 5), the ack dead-end (2), turn anchoring (3), and timeouts (4) in the contract now.
2. Reuse the bootstrap command and provenance plumbing instead of re-declaring them (7, 8).
3. Delete the platform-handler layer (12).

Update [ntbs-architecture.md](./ntbs-architecture.md) alongside — several findings (3, 8) are places where the skeleton diverged from decisions the docs already got right.
