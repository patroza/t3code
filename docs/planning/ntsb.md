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

The problem is to define how these surfaces participate in T3 without creating a second domain model beside T3's existing one. The T3 event log remains canonical. NTBS support should select and project an explicit subset of existing T3 commands, events, and state, while platform adapters translate between that subset and each platform's native concepts.

This requires a shared contract that answers several questions consistently across platforms:

- what an external object corresponds to in T3;
- which T3 commands an external participant may cause;
- which T3 events and projected state an NTBS client may observe;
- how later external changes, multiple participants, retries, and replay affect that state;
- what limited clients render, ignore, or report as unsupported.

The shared contract should be smaller than the full interactive-client protocol, event-based, and usable through both snapshots and incremental changes. Platform adapters should remain responsible for authentication, source-event translation, transport, and rendering—not for defining their own conversation semantics.

## Scope of this document

This document will capture the protocol design one decision at a time. It does not yet prescribe an object-to-thread mapping, a command or event subset, lifecycle semantics, cursor rules, or adapter behavior. Those decisions will be added only after they are discussed and agreed.

Implementation is out of scope for this planning stage.

## Proposal: A triggering event creates a new thread

Each accepted external event that triggers an agent turn creates a new T3 thread. The first user message is constructed from the captured source snapshot of the external source together with the event that triggered the run. Authorization to access the source is checked separately. In the existing T3 protocol, this can be expressed with `thread.turn.start` and `bootstrap.createThread`; it does not require a separate NTBS command.

An external event is not the same as a delivery attempt. Retries and duplicate webhook deliveries must resolve to the same accepted event and must not create additional threads. The identity and idempotency rules needed to guarantee this are still to be designed.

Triggering events for the same external interaction may start T3 threads concurrently. Each thread is correlated with the external event that created it, and its output is projected to that event's response target. A later event does not alter, steer, or continue an earlier thread merely because both belong to the same external interaction.

### Advantages

- The external source remains the participant-visible context for the run; behavior does not depend on hidden T3 conversation history that external participants cannot inspect.
- Each run has an isolated and auditable input, actor, output, and lifecycle.
- An edit can trigger a new run from the updated source snapshot without rewriting the history of a previous T3 thread.
- Different participants do not implicitly inherit stale or private context accumulated in an earlier agent session.
- Replay can reconstruct what the agent was asked to do from the captured source version and triggering event.
- Closing, reopening, deleting, or moving an external object does not need to masquerade as T3 thread lifecycle.
- The normal path initially needs only the existing bootstrap form of `thread.turn.start`.

### Costs and limitations

- Rebuilding the external snapshot for every run may increase prompt size, latency, and model cost.
- T3-only context such as intermediate tool activity or prior instructions is lost unless it is deliberately included in the new prompt.
- A high-volume external discussion may create many short-lived T3 threads, increasing storage and making native T3 discovery noisier.
- Independent threads can still target the same worktree or other mutable resource, so execution needs separate serialization or conflict rules.
- An external reply cannot continue an in-flight approval, user-input request, interrupt, or steering interaction merely by creating another thread; those interactions would need an explicit command targeting the existing thread or be unsupported.
- Reliable replay requires the system to retain or reconstruct the exact captured source snapshot used for the run, not merely fetch whatever the source contains later.

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
