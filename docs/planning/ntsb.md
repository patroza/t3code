# Non-turn-based surfaces

**Status:** exploratory planning

## Overview

T3 currently models interaction primarily as a conversation between one user and an agent. A user submits a message, the agent runs a turn, and T3 presents the resulting conversation and runtime state through clients that understand the full T3 model.

Non-turn-based surfaces (NTBS) such as Discord, Jira, Teams, GitHub issues, and pull requests do not share those assumptions. They are independently owned collaboration systems where:

- several people may interact with the same external object;
- messages, comments, and object state may be edited or deleted after T3 first observes them;
- objects may be closed, reopened, moved, locked, or otherwise changed outside T3;
- events may arrive late, more than once, or after T3 has been offline;
- the platform can render only a small part of the state and activity available in a native T3 client.

The problem is to define how these surfaces participate in T3 without creating a second domain model beside T3's existing one. The existing T3 event log remains the source of truth for T3 state. NTBS support should reuse existing T3 commands, events, and state where possible, while platform adapters translate between T3 and each platform's native concepts.

This requires a shared contract that answers several questions consistently across platforms:

- how an external interaction is identified and related to its T3 threads;
- which T3 commands an adapter may issue in response to an external event;
- which T3 events and state an adapter may use to render a response on the external platform;
- how later edits, deletions, multiple participants, retries, and replay affect event handling and response rendering;
- what an adapter does when the external platform cannot represent a T3 event or response;

The integration protocol should expose only the T3 commands and state needed by these adapters. Adapters should be able to obtain an initial state and then receive subsequent changes. Platform adapters should remain responsible for authentication, source-event translation, transport, and rendering—not for defining their own conversation semantics.

## Scope of this document

This document defines the protocol-level relationship between T3 and non-turn-based surfaces. It covers event processing and trigger rules, thread creation, interaction identity, lifecycle, client state, cursors, and adapter behavior. Detailed decisions may be developed in companion planning documents, but remain part of this document's scope.

Implementation is out of scope for this planning stage.

## Proposal: A triggering event creates a new thread

Each event that matches a trigger creates a new T3 thread from the event and its captured source snapshot; the detailed trigger, processing, concurrency, and response-routing rules are defined in [ntsb-event-processing.md](./ntsb-event-processing.md).

## Open questions

- What identifies the same external interaction for correlation and projection: a Jira issue, Discord thread, GitHub issue or pull request, nested review discussion, Teams conversation, or another scope?
- Is the source snapshot frozen when an event is accepted or fetched immediately before its thread starts?
- If resource coordination delays a thread after its event is accepted, does it retain its original snapshot, or may the snapshot be refreshed?
- What stable identity distinguishes an accepted external event from duplicate, retried, late, or out-of-order deliveries?
- How are concurrent executions that share a worktree or another mutable resource coordinated without imposing an event queue?
- NTBS does not target existing execution threads; each accepted event uses the new-thread form of `thread.turn.start`.
- Which T3 events and projected fields may NTBS clients consume, and which are deliberately omitted or unsupported?
- How do clients obtain an initial snapshot, resume from a cursor, replay missed changes, and recover when their cursor is no longer valid?
- How are completion, failure, timeout, and cancellation represented and rendered on limited external platforms?
- How is an external event correlated with its T3 execution thread and the response rendered back onto the source?
- How long are captured source snapshots, execution threads, and their correlation records retained, and how are they presented in native T3 clients?

## Agreed decisions

### Which external messages or state changes trigger an agent turn, and which are ignored or recorded without starting work?

The platform-specific trigger forms, ignored events, thread creation, and response routing are defined in [ntsb-event-processing.md](./ntsb-event-processing.md).
