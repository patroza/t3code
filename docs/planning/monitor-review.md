# NTBS turn monitor review

The monitoring loop has a sound basic structure: it establishes a baseline, checks the projected turn repeatedly, resets its inactivity counter when observable progress appears, and stops when the turn reaches a terminal state. The following issues should be addressed before relying on it operationally.

## Findings

1. The monitor reads `thread.latestTurn`, not necessarily the original NTBS turn. If someone starts another turn in the same T3 thread, the monitor can silently switch targets. It should retain or recover the original `userMessageId` and use it to identify the correct turn.

2. Multiple monitors for the same thread share and overwrite the same `threadStatus` entry. Their alternating checks could make inactivity accumulate too quickly. The processor should track which thread IDs already have an active monitor and refuse to start a duplicate.

3. The stored status is removed only when a terminal turn is observed. It remains in memory when monitoring stops because of inactivity, failure, or interruption. Monitor termination should always remove the thread's entry from `threadStatus`.

4. A temporary failure while reading the T3 projection terminates the monitor permanently. A failed check should be logged and retried on a later interval. It should not count as evidence that the turn made no progress.

5. `loadThreadStatus` treats every missing `latestTurn` as a pending turn. It should verify that `pendingTurnStart` exists and belongs to the expected user message. If neither a pending request nor the expected turn exists, the projected T3 state is inconsistent and should produce an error.

6. Six unchanged checks at 15-second intervals represent 90 seconds without observable progress, not the two minutes stated by the current log message. A two-minute threshold requires eight unchanged checks.

7. The current stalled-turn branch only writes a debug log and stops monitoring. The T3 turn continues running without further supervision. The final implementation must apply the chosen stalled-turn policy, such as interrupting the turn and posting a timeout response.

8. The progress heuristic cannot reliably observe buffered assistant output, hidden reasoning, or provider work that produces no projected event. A healthy turn may therefore appear unchanged. A short inactivity threshold increases the likelihood of false positives, so the initial threshold should be conservative and reviewed using real behavior.

## Recommended first fix

Track the original `userMessageId` when monitoring. Correctly identifying the intended turn is required before any progress comparison, timeout, or stalled-turn action can be trusted.
