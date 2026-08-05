# NTBS architecture

**Status:** exploratory planning

This document defines the boundary between T3 and adapters for non-turn-based surfaces such as Jira, GitHub, Discord, and Teams. It explains which system retains which information and the shared path from an external event to a T3 result and back to the external platform.

## Problem

T3 clients are built around T3 data views such as threads, diffs, and projects. External platforms know none of those concepts. They only know their own messages, comments, conversations, and identifiers.

An adapter therefore cannot rely on an external platform to retain T3 state, and T3 cannot infer where a later result belongs from its own thread data alone. The adapter must retain the link between its platform's event and the T3 work created from it.

## Shared model

An adapter receives a platform event, applies the trigger rules, captures the source snapshot, and creates a new T3 thread. It retains the platform identifiers and the T3 identifiers created from that event.

The adapter sends an acknowledgement to the external platform. When T3 reports the thread's final outcome, the adapter uses its retained record to post the final answer, failure, timeout, or cancellation in the correct place.

T3 remains independent of the platform that produced the event. It owns its threads, messages, turns, execution state, worktrees, and branches. The adapter owns platform authentication, event delivery, source snapshots, platform identifiers, response placement, and platform-specific rendering.

## Adapter record

For each event that starts T3 work, the adapter needs a durable record containing:

- the platform's source event ID and version;
- the source context and message or comment identifiers;
- the captured source snapshot;
- the T3 thread, user-message, and turn identifiers created from the event;
- the acknowledgement and final-message identifiers, when they have been posted;
- the delivery state for both outbound messages.

This record lets the adapter avoid creating duplicate threads, resume after a restart, and deliver a later T3 outcome to the correct external location.

## Shared flow

1. The adapter receives an external event and decides whether it starts T3 work.
2. The adapter creates or reuses its durable record and captures the source snapshot.
3. The adapter asks T3 to create a new thread and retains the resulting T3 identifiers.
4. The adapter posts the acknowledgement and records its message identifier.
5. T3 reports the thread's final outcome.
6. The adapter finds the corresponding record, posts the outcome, and records the result of that delivery.

## Decisions still needed

- Define the request from an adapter to T3: the source snapshot, target project, starting revision, and execution settings.
- Define how an adapter receives thread outcomes from T3, including replay after an adapter restart.
- Define the exact idempotency rules for source events, edits, retries, late delivery, and out-of-order delivery.
- Choose the durable storage implementation and retention policy for adapter records.
- Define what happens when the source object is deleted, closed, archived, or otherwise changes while T3 work is running.

## Related documents

- [ntsb.md](./ntsb.md) records the overall scope and agreed decisions.
- [ntsb-event-processing.md](./ntsb-event-processing.md) defines inbound triggers and outbound messages on each platform.
