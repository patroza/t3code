# NTBS fixes

This document collects the units of work identified by the adversarial review of the NTBS design.

## 5. Preserve platform actor checks in the adapters

The current Jira and GitHub integrations check whether the external account is allowed to start agent work, but the NTBS skeleton does not mention this behavior. Without carrying it into the new adapters, porting those integrations would silently remove an existing check.

Each adapter must apply its platform-specific actor checks before sending a request to the shared processor. Input that fails those checks does not enter the NTBS lifecycle. The shared processor does not need an actor-trust model or any additional trust data.

## 6. Remove the shared platform-handler abstraction

`NTBSPlatformHandler` only states that a platform has a `handle` function. Each platform receives a different input type, and no shared code uses these handlers interchangeably, so the interface and its Effect tag add no shared behavior.

Delete `platform-handler.ts`. Each platform adapter instead exposes its own concrete inbound function, such as a Jira webhook handler or Discord message handler. That function verifies and parses the platform input, applies its trigger and actor checks, builds the generic NTBS request and `T3Context`, and calls the shared processor. Keep `NTBSAdapter` limited to the storage and outbound operations used by the processor.

## 7. Pass a response union to the adapter

The processor currently reduces every T3 outcome to plain text before calling the adapter. The adapter therefore cannot distinguish a normal answer from a failure, timeout, or cancellation when applying its platform-specific rendering.

Define a small response union with `answer`, `failure`, `timeout`, and `cancellation` cases, each carrying its response text. The processor determines which case occurred and passes it to `postResponse`; the adapter decides how that case is rendered on its platform. This response union is not an additional persisted lifecycle state.

## 11. Define the shared thread defaults

T3 requires an initial title, model selection, runtime mode, and interaction mode when creating a thread. `T3Context` currently provides only the project and revision, so the implementation would otherwise have to invent these choices or make each platform choose them independently.

Keep `T3Context` limited to `projectId` and `revision`. The shared processor applies the same policy for every platform:

- Create the thread with T3's default title and let the normal first-turn title generation replace it.
- Use the project's default model selection, falling back to T3's automatic bootstrap model selection.
- Use `full-access` runtime mode.
- Use `default` interaction mode.
- Treat `revision` as the Git ref from which the new isolated worktree starts, and resolve it when creating that worktree.

Adapters provide the project and revision but do not choose or persist the remaining thread settings in the first implementation.

## 12. Resolve the response for the correct T3 message

The processor currently stores only the T3 thread ID and reads the latest turn when looking for the final response. If someone continues that thread from a native T3 client, the latest turn may belong to different work and its answer could be posted back to the original external request.

Store the ID of the first T3 user message with `ThreadStarted`. Resolve the final response for that specific message instead of reading the latest turn in the thread. Record the corresponding turn ID later when T3 provides it.

## 13. Archive the T3 thread after posting the response

Every external request creates a new T3 thread and worktree. Leaving them open after the response has been posted would cause unused threads and worktrees to accumulate.

After the response has been successfully posted and saved as `ResponsePosted`, archive its T3 thread so the normal T3 cleanup rules can remove the worktree. Treat archival as separate cleanup: if it fails, retry the archival without posting the response again. This can become a configurable retention policy later if a platform needs different behavior.

## 14. Keep remote adapters in mind

The current NTBS shape assumes adapters run inside the T3 server and call the processor directly. This works for the initial Jira and GitHub adapters, but the current Discord bot runs as a separate program.

When Discord is ported, either move its adapter into the server or expose the processor through a network API. Do not choose or implement that transport yet, but avoid making the lifecycle and storage design depend unnecessarily on every adapter sharing the server process.

## 15. Verify an uncertain response before posting it again

The adapter may successfully post a response and then stop before saving `ResponsePosted`. On recovery, it must not immediately post the response again.

First inspect recent messages in the known response destination. Look for a message authored by the adapter, posted in the expected time frame, attached to the expected comment or thread, and containing the expected response. If it is found, save `ResponsePosted` using the existing platform message and continue without posting again. Retry `postResponse` only when that check finds no matching message.

Each adapter owns the exact comparison because platforms may format, truncate, or split messages differently.

## 16. Recover missed T3 events after restart

The processor only receives T3 events emitted while it is running. If T3 finishes work while the processor or server is down, the completion event is missed and the response would never be posted.

Whenever the processor starts, load every unfinished NTBS record and check its current state in T3. Continue completed work, report failures, and resume waiting for work that is still running. Treat live T3 events as signals to check the current state, not as the only record of what happened.

This recovery does not require storing an event cursor or replaying the T3 event log. T3's current state and the adapter's unfinished records provide enough information to continue.

## 17. Handle work that does not finish in time

The processor currently waits forever for T3 to report that a turn has finished. If the provider hangs or disconnects without producing a completion event, the external platform never receives a final message.

Check the target turn after 30 minutes:

- If it is `running` or `starting`, wait another 15 minutes.
- If it is `completed`, retrieve and post its answer.
- If it is in `error`, `interrupted`, or `stopped`, post that failure without automatically rerunning the agent.
- If no turn ever started, retry the turn-start command once when it is safe to repeat.
- If the thread cannot be read because of a temporary failure, retry the status check rather than the T3 work.
- If the thread no longer exists, post an error and stop.

If the turn is still running after 45 minutes, post that T3 is still working and include a link to the T3 thread. Then close the external response flow. A later answer remains available in T3 but is not posted automatically to the external platform.
