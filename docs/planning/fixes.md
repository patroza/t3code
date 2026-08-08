# NTBS fixes

This document collects the units of work identified by the adversarial review of the NTBS design.

## 1. Remove the pre-thread lifecycle state

`RequestAccepted` exists to recover a request when the server stops before recording `ThreadStarted`. Supporting that narrow failure window requires planned thread IDs, searches for unfinished requests, startup retries, and rules for resuming duplicates.

Do not add that machinery in the first implementation. Remove `RequestAccepted` and make `ThreadStarted` the first stored lifecycle state. Record it as soon as the basic T3 thread exists, before slower worktree preparation or project setup begins.

This deliberately accepts one limitation: if the server stops before `ThreadStarted` is saved, the request may be lost. The user receives no acknowledgement and can send the request again. If this becomes a real problem, each adapter can later inspect recent platform messages and recover missing requests using the capabilities of that platform.

## 2. Make acknowledgements independent from the shared lifecycle

The acknowledgement is a platform message such as "working on it." It improves feedback for the user, but the current types make its message ID mandatory for `ResponseAvailable` and `ResponsePosted`. If posting the acknowledgement fails, the processor cannot represent or post the final response even though T3 work can continue.

After creating the T3 thread, the processor records `ThreadStarted`. Starting the T3 work and attempting to post the acknowledgement are then independent operations. A failed acknowledgement must not prevent the work from starting, completing, or returning its final response.

Remove `ThreadStartedAcknowledgement` from the shared lifecycle and remove `acknowledgementMessageId` from later lifecycle states. An adapter may retain the acknowledgement ID in its own storage and retry posting when appropriate, but final-response processing must not depend on it.

## 3. Resolve the response for the correct T3 message

The processor currently stores only the T3 thread ID and reads the latest turn when looking for the final response. If someone continues that thread from a native T3 client, the latest turn may belong to different work and its answer could be posted back to the original external request.

Store the ID of the first T3 user message with `ThreadStarted`. Resolve the final response for that specific message instead of reading the latest turn in the thread. Record the corresponding turn ID later when T3 provides it.
