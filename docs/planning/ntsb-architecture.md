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

The adapter keeps the full record for its platform. T3 does not receive or interpret the adapter's source-event data or response destination. The adapter detects repeated deliveries, creates the snapshot, and asks T3 to start work. T3 receives the snapshot, returns the new thread, message, and turn IDs, and later reports the final outcome. The adapter adds those T3 values to its own record and posts the result on its platform.

## Event lifecycle

Starting from an external event, this happens:

1. The adapter accepts an external event that matches a trigger. It creates an adapter record containing the source identifiers, response destination, and captured snapshot.
2. The adapter asks T3 to create a new thread from that snapshot.
3. T3 creates the thread, user message, and turn. The adapter adds those IDs to its record.
4. The adapter posts the acknowledgement and adds its message ID to the record.
5. T3 produces the final answer, failure, timeout, or cancellation for that turn.
6. The adapter finds the record from the T3 IDs, posts the final message at its stored response destination, and adds the final-message ID to the record.

## Adapter record

Before it asks T3 to create a thread, the adapter record contains:

- the adapter's own source-event data;
- the adapter's own response destination;
- the captured source snapshot as a string;

After T3 creates the thread, the adapter adds the T3 thread, user-message, and turn IDs.

After it posts the acknowledgement and final response, the adapter adds their message IDs.

The record retains the accepted source event, the new T3 thread it starts, and the messages the adapter sends for that thread.

`NtsbEventRecord` is a TypeScript pattern for adapter code, not a shared storage format. Each adapter defines, validates, and stores its own source-event data and response destination.

```ts
/**
 * Tracks the lifecycle of external inbound events, such as comments or messages, that trigger T3 work.
 * External applications have no relationship to T3, and vice versa. The adapter relates events in one to the other.
 */
type NtsbEventRecord<SourceEvent, ResponseDestination> = {
  /** Adapter-defined information about the inbound event. */
  source: SourceEvent;
  /** Adapter-defined information about where replies belong. */
  responseDestination: ResponseDestination;
  /** The captured source text used to create T3's first user message. */
  snapshot: string;
  /** The T3 IDs created after the adapter starts work. */
  t3?: {
    /** The T3 thread created from the source event. */
    threadId: string;
    /** The first T3 user message created from the snapshot. */
    userMessageId: string;
    /** The T3 turn started from that message. */
    turnId: string;
  };
  /** The external acknowledgement message posted by the adapter. */
  acknowledgementMessageId?: string;
  /** The external final message posted by the adapter. */
  finalMessageId?: string;
};
```

The optional fields in this initial type represent different points in the event lifecycle. They must be replaced with separate record shapes once those lifecycle transitions have been fully defined.

## Jira example

A user adds top-level Jira comment `10401` on issue `T3-123`: `@agent investigate the failed build`. The adapter accepts source event `jira-event-1`, version `1`, and stores this record before asking T3 to do anything:

```ts
{
  source: {
    platform: "jira",
    eventId: "jira-event-1",
    version: "1",
    contextId: "T3-123",
    messageId: "10401",
  },
  responseDestination: {
    contextId: "T3-123",
    parentMessageId: "10401",
  },
  snapshot: "@agent investigate the failed build",
}
```

When T3 creates the work, the adapter adds its IDs:

```ts
t3: {
  threadId: "thread-1",
  userMessageId: "message-1",
  turnId: "turn-1",
}
```

The adapter posts an acknowledgement as a reply to Jira comment `10401` and adds `acknowledgementMessageId: "10402"`. When T3 produces the final result for `turn-1`, the adapter finds this record, posts another reply to comment `10401`, and adds `finalMessageId: "10403"`.

## Decisions still needed

- Define the request from an adapter to T3: the source snapshot, target project, starting revision, and execution settings.
- Define how an adapter receives thread outcomes from T3, including replay after an adapter restart.
- Define the exact idempotency rules for source events, edits, retries, late delivery, and out-of-order delivery.
- Choose the durable storage implementation and retention policy for adapter records.
- Define separate record shapes for each lifecycle transition, replacing the optional fields in `NtsbEventRecord`.
- Define what happens when the source object is deleted, closed, archived, or otherwise changes while T3 work is running.

## Related documents

- [ntsb.md](./ntsb.md) records the overall scope and agreed decisions.
- [ntsb-event-processing.md](./ntsb-event-processing.md) defines inbound triggers and outbound messages on each platform.
