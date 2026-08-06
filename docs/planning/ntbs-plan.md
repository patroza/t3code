# NTBS implementation plan

**Status:** exploratory planning

## 1. Understand the existing mechanics

Read the orchestration command definitions, the orchestration engine service, and the WebSocket turn-start handling to understand how T3 creates threads, prepares worktrees, starts turns, persists events, and exposes those events to consumers.

Then follow the current Jira path from the webhook route and payload parser through the Jira bridge, delivery store, and Jira API client. This provides concrete examples of inbound event handling, platform-owned persistence, T3 command dispatch, acknowledgement delivery, outcome detection, and outbound response placement.

The current Jira bridge is a reference, not the desired architecture. It contains platform-independent behavior that should move into the shared NTBS implementation, and it currently reuses existing threads instead of creating a new thread for every accepted event.

## 2. Build the platform-agnostic NTBS implementation

Create `apps/server/src/ntbs` for the shared lifecycle model, adapter contract, and workflow service.

First, extract the existing create-thread, prepare-worktree, and start-turn mechanic from the WebSocket handler into a reusable orchestration service. Both native T3 clients and NTBS workflows should call this service so thread creation behaves consistently regardless of where the request originated.

Define an adapter contract that leaves platform data opaque to the shared workflow. Each adapter supplies persistence, duplicate prevention, acknowledgement delivery, final-response delivery, and the platform-specific data needed to place those messages.

Implement the shared workflow:

1. Accept the snapshot, T3 context, and opaque platform data from an adapter.
2. Persist the accepted lifecycle state before starting T3 work.
3. Create a new T3 thread and worktree, start its first turn, and retain the resulting T3 identifiers.
4. Ask the adapter to post the acknowledgement and retain its platform message identifier.
5. Consume T3 events, including replay after a restart, and identify the final outcome for the recorded work.
6. Load the final assistant text or failure information and ask the adapter to post the final message.
7. Persist every lifecycle transition so interrupted processing can resume safely.

Confirm when the T3 turn ID becomes available during this work. The current command path knows the thread and user-message IDs immediately but discovers the turn ID later. The implementation and lifecycle types must represent that sequence accurately.

Test the shared workflow with an in-memory adapter implementation before connecting it to a real platform. The tests should cover successful completion, failure, duplicate delivery, restart recovery, and concurrent events.

## 3. Port Jira onto the shared implementation

Keep Jira webhook verification, payload parsing, trigger recognition, Jira identifiers, and Jira API calls inside the Jira adapter.

Replace the shared workflow currently embedded in the Jira bridge with an implementation of the NTBS adapter contract. Adapt the Jira delivery store to persist the NTBS lifecycle together with Jira-specific source and response-destination data.

Change Jira processing so every accepted event creates a new T3 thread. Preserve the agreed outbound behavior: post an acknowledgement for the invoking comment, then post the final answer, failure, timeout, or cancellation as a separate reply in the same Jira comment scope.

Update the Jira tests to prove trigger handling, duplicate prevention, lifecycle recovery, new-thread creation, acknowledgement placement, final-response placement, and concurrent invocations.

# Notes

In `packages/contracts/src/orchestration.ts` we can find the schema `ThreadTurnStartBootstrapCreateThread`.

The schema wants:

- `projectId` (project should be inferred by discord/jira/etc)
- `title` (generated somewhere)
- `modelSelection` (some model)
- `runtimeMode` (permissions)
- `interactionMode` (apparently default vs plan)
- `branch` (git branch?)
- `worktreePath` (where is it on filesystem)

It is then used by the

`ThreadTurnStartBootstrap` which has some optional data for running setup script, preparing worktrees which is then used by

`ThreadTurnStartCommand` and `ClientThreadTurnStartCommand` (essentially the same type)
