import { assert, describe, it } from "@effect/vitest";

import type { OrchestrationEvent } from "@t3tools/contracts";

import { isThreadDetailEvent } from "./ws.ts";

const event = (type: string): OrchestrationEvent =>
  ({
    type,
    aggregateKind: "thread",
    aggregateId: "thread-1",
    sequence: 1,
    occurredAt: "2026-07-14T00:00:00.000Z",
    eventId: "event-1",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {},
  }) as unknown as OrchestrationEvent;

describe("isThreadDetailEvent", () => {
  // A thread-detail subscriber resumes from `afterSequence` and never re-reads
  // the projection, so anything omitted here never reaches the client at all.
  it("passes the events a thread transcript is built from", () => {
    for (const type of [
      "thread.message-sent",
      "thread.messages-resynced",
      "thread.proposed-plan-upserted",
      "thread.activity-appended",
      "thread.turn-diff-completed",
      "thread.reverted",
      "thread.session-set",
    ]) {
      assert.isTrue(isThreadDetailEvent(event(type)), `${type} must reach thread subscribers`);
    }
  });

  it("passes resync events so a rebuilt transcript reaches connected clients", () => {
    // Regression: this was omitted, so backfills were written and projected but
    // silently dropped en route to every client.
    assert.isTrue(isThreadDetailEvent(event("thread.messages-resynced")));
  });

  it("drops events a transcript does not render", () => {
    for (const type of [
      "thread.created",
      "thread.archived",
      "thread.turn-start-requested",
      "project.created",
    ]) {
      assert.isFalse(isThreadDetailEvent(event(type)), `${type} must not reach thread subscribers`);
    }
  });
});
