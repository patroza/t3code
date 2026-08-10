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

The adapter keeps the full record for its platform. T3 does not receive or interpret platform data. The adapter makes sure the same platform message does not start T3 work twice, creates the snapshot, and asks T3 to start work. T3 receives the snapshot, returns the new thread, message, and turn IDs, and later reports the final outcome. The adapter adds those T3 values to its own record and posts the result on its platform.

Storage and retention are adapter implementation details, not architecture decisions. Platform-specific edge cases, such as a source item being deleted or closed while T3 is working, also belong to the adapter implementation phase.

## Passing T3 context

An incoming platform event carries both platform data and the T3 context needed to start work, such as the project, base ref, and execution context. The base ref is the starting point for the thread's worktree — usually a branch name such as `main`, resolved against `origin` before use, or a commit SHA used as-is. The adapter forwards that T3 context to T3 when it creates the new thread.

`NtbsEvent` does not retain the project, base ref, or execution context as lifecycle data. Once T3 creates the thread, T3 owns that information. Keeping copies in `NtbsEvent` would require the adapter to keep them in sync with T3.

## Receiving T3 outcomes

Adapters subscribe to T3's event log, like other T3 consumers. After T3 starts a thread, `NtbsEvent` contains its turn ID. When the adapter receives the final outcome for that turn from the event log, it uses the same `NtbsEvent` to post the result on the external platform.

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

- the adapter's platform data;
- the captured source snapshot as a string;

After T3 creates the thread, the adapter adds the T3 thread, user-message, and turn IDs.

After it posts the acknowledgement and final response, the adapter adds their message IDs.

The event retains the accepted source event, the new T3 thread it starts, and the messages the adapter sends for that thread.

`NtbsEvent` is a TypeScript pattern for adapter code, not a shared storage format. Each adapter defines, validates, and stores its own platform data.

```ts
/** All data that is specific to the external platform. */
type PlatformData<Source, ResponseDestination> = {
  /** Information about the inbound event. */
  source: Source;
  /** Information about where replies belong. */
  responseDestination: ResponseDestination;
};

/**
 * Tracks the lifecycle of external inbound events, such as comments or messages, that trigger T3 work.
 * External applications have no relationship to T3, and vice versa. The adapter relates events in one to the other.
 */
type NtbsEvent<P extends PlatformData<unknown, unknown>> =
  | NtbsEventAccepted<P>
  | NtbsEventThreadStarted<P>
  | NtbsEventAcknowledgementPosted<P>
  | NtbsEventOutcomeAvailable<P>
  | NtbsEventResponsePosted<P>;

type NtbsEventBase<P extends PlatformData<unknown, unknown>> = {
  /** Adapter-defined data for the external platform. T3 does not inspect it. */
  platformData: P;
  /** The captured source text used to create T3's first user message. */
  snapshot: string;
};

type NtbsEventAccepted<P extends PlatformData<unknown, unknown>> = NtbsEventBase<P> & {
  /** The adapter has accepted the inbound event but has not started T3 work. */
  state: "accepted";
};

type NtbsEventWithThread<P extends PlatformData<unknown, unknown>> = NtbsEventBase<P> & {
  /** The T3 IDs created after the adapter starts work. */
  t3: {
    /** The T3 thread created from the source event. */
    threadId: string;
    /** The first T3 user message created from the snapshot. */
    userMessageId: string;
    /** The T3 turn started from that message. */
    turnId: string;
  };
};

type NtbsEventThreadStarted<P extends PlatformData<unknown, unknown>> = NtbsEventWithThread<P> & {
  /** T3 has created the new thread from the source snapshot. */
  state: "threadStarted";
};

type NtbsEventWithAcknowledgement<P extends PlatformData<unknown, unknown>> =
  NtbsEventWithThread<P> & {
    /** The external acknowledgement message posted by the adapter. */
    acknowledgementMessageId: string;
  };

type NtbsEventAcknowledgementPosted<P extends PlatformData<unknown, unknown>> =
  NtbsEventWithAcknowledgement<P> & {
    /** The adapter has posted the acknowledgement. */
    state: "acknowledgementPosted";
  };

type NtbsEventOutcomeAvailable<P extends PlatformData<unknown, unknown>> =
  NtbsEventWithAcknowledgement<P> & {
    /** T3 has produced a final outcome for the turn. */
    state: "outcomeAvailable";
  };

type NtbsEventResponsePosted<P extends PlatformData<unknown, unknown>> =
  NtbsEventWithAcknowledgement<P> & {
    /** The adapter has posted T3's final response. */
    state: "responsePosted";
    /** The external final message posted by the adapter. */
    finalMessageId: string;
  };
```

TODO: Define error and retry lifecycle states when adapter behaviour is tested.

## Jira example

A user adds top-level Jira comment `10401` on issue `T3-123`: `@agent investigate the failed build`. The adapter accepts source event `jira-event-1`, version `1`, and stores this record before asking T3 to do anything:

```ts
{
  state: "accepted",
  platformData: {
    source: {
      eventId: "jira-event-1",
      version: "1",
      contextId: "T3-123",
      messageId: "10401",
    },
    responseDestination: {
      contextId: "T3-123",
      parentMessageId: "10401",
    },
  },
  snapshot: "@agent investigate the failed build",
}
```

When T3 creates the work, the adapter adds its IDs:

```ts
state: "threadStarted",
t3: {
  threadId: "thread-1",
  userMessageId: "message-1",
  turnId: "turn-1",
}
```

The adapter posts an acknowledgement as a reply to Jira comment `10401`, changes the state to `"acknowledgementPosted"`, and adds `acknowledgementMessageId: "10402"`. When T3 produces the final result for `turn-1`, the state becomes `"outcomeAvailable"`. The adapter then posts another reply to comment `10401`, changes the state to `"responsePosted"`, and adds `finalMessageId: "10403"`.

## Related documents

- [ntbs.md](./ntbs.md) records the overall scope and agreed decisions.
- [ntbs-event-processing.md](./ntbs-event-processing.md) defines inbound triggers and outbound messages on each platform.
