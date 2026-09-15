# Timeout tests

## Pure deciders

- [x] A fresh `work-planned`, `thread-created`, or `reply-pending` exchange with an `unknown` context returns `wait`. — `unknown` rows in the decider tables in `exchange.test.ts`
- [x] The same states return `expire` when their deadline has passed. — `unknown`/`later` rows in the same tables
- [x] A confirmed present thread, completed turn, or posted reply still wins after expiry. — `present`/`completed reply`/`posted` at `later` rows in the same tables

## Timed-out observations

- [x] `getThreadStatus`, `getTurnStatus`, and `findPostedReply` each time out, release the exchange lock, and do not start provisioning, a turn, or a second reply post. — `times out $observation, releases the lock, and does not call $action`
- [x] A failed check after expiry moves the exchange to its terminal failure outcome. — `expires an exchange to its terminal outcome when $observation fails after expiry` (and the hanging variant)
- [x] A check after expiry that succeeds still records the confirmed result. — `records the confirmed result of a $observation check that succeeds after expiry`

## Timed-out actions

- [x] Planning timeout leaves `RequestAccepted`; a later pass either succeeds or expires it. — `leaves RequestAccepted after a planning timeout, and a later pass $outcome`
- [x] Provisioning timeout leaves `WorkPlanned`, does not remove the worktree, and a later observation can discover a created thread. — `leaves WorkPlanned after a provisioning timeout and later discovers a created thread`; worktree kept covered by `keeps the worktree when a provision is interrupted` in `t3gateway.test.ts`
- [x] Turn-start timeout leaves `ThreadCreated`; a later observation can discover the turn rather than start it twice. — `leaves ThreadCreated after a turn-start timeout and later discovers the turn`
- [x] Reply-post timeout leaves `ReplyPending`; a later `findPostedReply` result prevents a duplicate post. — `leaves ReplyPending after a reply-post timeout and later discovers the reply`
- [x] Acknowledgement timeout does not undo the already-persisted `ThreadCreated` state. — `keeps ThreadCreated when the acknowledgement times out`

## Deadline boundaries

- [x] An action gets no more than the time remaining before its state deadline. — `gives an action no more than the time remaining before its deadline`
- [x] An expired state does not start a new action. — `does not start an action for a state that is already expired`
- [x] A timeout does not itself create a failure reply or trigger cleanup; the next observation decides what happened. — `leaves the outcome to the next observation after an action timeout` (cleanup covered by `keeps the worktree when a provision is interrupted`)

## Recovery and concurrency

- [x] A timed-out exchange can be driven again by the sweeper. — `re-drives a timed-out exchange from the sweeper`
- [x] A timed-out exchange can be driven again by a thread-activity event. — `re-drives a timed-out exchange from a thread-activity event`
- [x] A second delivery waiting on the same exchange lock proceeds once the first attempt times out. — `lets a queued delivery proceed once the first attempt times out`
- [x] One timed-out exchange does not stop recovery or sweeping for other exchanges. — `does not let one timed-out exchange stop the others`
