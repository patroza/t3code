# Competing outcome-drivers

Outcome drivers are APIs that handle the turn end

In `processor.ts` right now, both `monitorT3Turn` and `processT3Event` are competing for the same turn projection.

The first one has a poll-based mechanism. After a turn starts, the polling checks changes and attempts to detect terminal state.

The second one listens for `thread.session-set` events emitted by the T3 orchestration engine.

We should analyze this issue and decide which one to keep.

The important simplification is not which one wins; it is that terminal outcome response has a single owner.

# Is the whole NTBS contract a state machine under disguise?

`NTBSAdapter.save` is a generic write: "store this record, whatever it is".

Nothing enforces/prevents bad transitions (e.g. `ResponsePosted -> ThreadCreated`) or two records of the same external request.

A byproduct of this is that lots of choreography is shifted as a responsibility of the processor itself which has to continuously ask whether it's not dealing with a dedup and such.

Idea: could `save` be instead replaced with a proper state machine that uniquely indexed on the request URI?
