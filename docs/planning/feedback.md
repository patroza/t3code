In ntsb-event-processing.md:

- “authorized request”
- “enabled interaction”
- “accepted request/event”
- “qualifying event”
- “request for the agent”
- “new explicit invocation”
- “source snapshot permitted by the access check”
- “pending turn record” — especially wrong now that we decided not to
  queue NTBS work

- “stable source event identity” — this is appropriately a TODO, but
  should be described consistently

- “external interaction”
- “response destination”
- “correlation record”
- “shared-resource coordination”
- “provider execution”

The most distracting ones are qualifying, authorized, accepted, and
enabled. I’d replace them with concrete language such as:

- “an event that matches one of the triggers below”
- “an event accepted after webhook/authentication checks”
- “the external object or conversation that contains the event”
- “the exact comment or message to which T3 posts the answer”

In ntsb.md:

- “canonical” event log
- “explicit subset” of commands/events/state
- “projected state”
- “limited clients”
- “source-event translation”
- “accepted external event”
- “agent turn”
- “captured source snapshot”
- “response target”
- “correlation record”
- “T3-only context”
- “external interaction”
- “lifecycle semantics”
- “deliberately omitted or unsupported”

There are also two concrete leftovers:

- The open question at line 64 still says events may be “recorded
  without starting work,” even though we moved that out of scope.

- Line 70 is a decision—“NTBS does not target existing execution
  threads”—but it is sitting among open questions and should not be
  phrased as one.

The biggest cleanup would be to remove qualifying, authorized, and
accepted wherever they are not carrying a distinct security or lifecycle
meaning, then define the few terms we actually need: external event,
external interaction, captured snapshot, T3 thread, and response
destination.
