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

## Agreed decisions

None yet.
