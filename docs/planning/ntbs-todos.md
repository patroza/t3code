# Is the whole NTBS contract a state machine under disguise?

`NTBSAdapter.save` is a generic write: "store this record, whatever it is".

Nothing enforces/prevents bad transitions (e.g. `ResponsePosted -> ThreadCreated`) or two records of the same external request.

A byproduct of this is that lots of choreography is shifted as a responsibility of the processor itself which has to continuously ask whether it's not dealing with a dedup and such.

Idea: could `save` be instead replaced with a proper state machine that uniquely indexed on the request URI?
