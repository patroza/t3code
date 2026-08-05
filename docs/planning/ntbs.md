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

## Agreed decisions

### Which external messages or state changes trigger an agent turn, and which are ignored or recorded without starting work?

The platform-specific trigger forms, ignored events, thread creation, and response routing are defined in [ntsb-event-processing.md](./ntsb-event-processing.md).

### What identifies the same external interaction for correlation and projection?

- Jira: the issue key or immutable issue ID. Comments and replies are events within that issue.
- Discord: the thread ID. The thread is the interaction.
- GitHub: the repository and pull-request number. Issue comments, review comments, and replies are events within that pull request; the triggering comment and any diff context belong to the individual event.
- Teams: unresolved. The likely scope is the conversation or reply-chain ID, with each message as its own event.

### When does the adapter capture the source snapshot relative to receiving a trigger and creating the T3 thread?

The adapter captures the source snapshot while processing the trigger, before creating the T3 thread. The new thread uses that captured snapshot.

### How does T3 prevent repeated delivery of the same source event from creating multiple threads?

Each adapter derives an idempotency key from the platform’s source-event identity and version. The adapter stores that key with the T3 thread created for the event. If the same key is delivered again, the adapter reuses the existing record and does not create another thread. A later edit or distinct source event receives a different key and may create a new thread. The exact event identity, versioning, and retention rules are platform-specific and remain to be defined.

### How are concurrent NTBS threads isolated without an event queue?

Each NTBS-triggered T3 thread receives its own worktree and branch before provider execution begins. Threads from the same external interaction can therefore run concurrently without sharing a mutable checkout or requiring an event queue.

### How are completion, failure, timeout, and cancellation reported for an external event?

They use the same response destination as the triggering event. Normal completion returns the agent’s answer; failure, timeout, or cancellation returns a response that explicitly reports the outcome and, where available, its reason. These outcomes do not create a separate external lifecycle or target a different thread.

### How does T3 associate a thread's outcome with the external event that created it, and where does the adapter post that outcome?

Each source event has a unique event ID. T3 stores a correlation record linking that event ID to the T3 thread, user message or turn, and exact response destination. When the turn ends, the adapter uses that record to post the answer or outcome back to the originating source.
