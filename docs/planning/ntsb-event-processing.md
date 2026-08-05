# NTSB event processing

**Status:** exploratory planning

This document defines how events arriving from non-turn-based surfaces are classified and converted into T3 work. It focuses on which events start new T3 threads, which events are ignored, and how independently started threads are correlated with their external events and responses.

## Inbound event processing

### Core rule

An external event starts a new T3 thread when the adapter recognizes it as one of the trigger forms defined below. Each triggering event creates a new T3 thread. NTBS does not explicitly target, continue, steer, or modify an existing T3 thread.

The event is captured together with the source snapshot used to construct the first user message. The adapter must distinguish a source event from delivery attempts. Retrying or redelivering the same source event must not create another T3 thread.

### Platform triggers

The following source interactions start a new thread:

#### Jira

- A top-level comment mentioning the agent.
- A reply mentioning the agent.
- A comment edit that adds the agent mention to a comment that previously did not invoke the agent.
- An edit to a comment that already invoked the agent does not trigger a new thread merely because its content changed. A new turn requires a new explicit invocation under the edited comment.

#### GitHub

- An issue or pull request comment mentioning the agent.
- A pull-request review comment or reply mentioning the agent.
- A comment edit that adds the agent mention to a comment that previously did not invoke the agent.
- An edit to a comment that already invoked the agent does not trigger a new thread merely because its content changed. A new turn requires a new explicit invocation under the edited comment.

#### Discord

- A human message mentioning the configured agent user.
- A human reply to an agent-authored message.
- A message edit that adds the configured agent mention to a message that previously did not invoke the agent.
- Editing a message that already invoked the agent does not start another thread merely because its content changed; a new turn requires a new explicit invocation.

### Processing a trigger

When a source interaction matches one of the triggers above, the adapter deduplicates the source event and captures the source snapshot used for the new thread. TODO: define the source event identity and idempotency rules, including late and out-of-order deliveries.

T3 then starts a new thread from that event and snapshot. A thread already running for the same external interaction does not delay, absorb, continue, or modify the new thread.

### Events that do not trigger work

- Edits to a comment that already invoked the agent, including edits that change its content, unless the edited comment contains a new explicit invocation.
- Duplicate or already-accepted deliveries do not create another thread. TODO: define the stable event identity and idempotency rules, including late and out-of-order deliveries.

Events that do not match one of the triggers above are ignored. Whether adapters retain them for deduplication, audit, or external-state projection is a separate concern.

### Concurrent turns

Multiple events from the same external interaction may create T3 threads at the same time. Each thread produces an answer for its own triggering event and sends that answer to the exact response destination associated with that event. Threads may finish in any order; completion order does not change where their answers are sent.

### Consequences

- Each event has isolated T3 context; a thread does not inherit the conversation history of another event.
- Each response must retain the exact destination associated with its triggering event.
- Capturing the source snapshot supports reproducibility, but may increase input size, latency, and model cost.
- High-volume external interactions may create many T3 threads and increase storage and discovery noise.

### Summary

- An invocation creates an independent T3 thread; it does not target or continue an existing thread.
- Multiple events from the same external interaction may create concurrent threads.
- Each thread produces its own answer, routed to the exact response destination associated with its originating event.
- Duplicate or already-accepted deliveries do not create another thread. TODO: define stable event identity and idempotency rules.

## Outbound response processing

The following questions remain open for the T3-to-NTBS path:

- Which T3 outputs are rendered on the external platform: only the final answer, or also intermediate updates, tool results, attachments, and generated artifacts?
- Does the adapter post the result as a reply, create a new comment or message, or update a message created earlier for the same turn?
- How does each adapter translate T3 formatting and content into the external platform's supported format and size limits?
- What happens when a response cannot be posted, is posted only partially, or must be retried?
- How are responses to concurrent turns ordered or labeled when they appear in the same external interaction?
- Which T3 events are intentionally kept inside T3 rather than rendered externally?
