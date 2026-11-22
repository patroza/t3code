import {
  CommandId,
  IdentityUsername,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  PersonId,
  type SourceRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";

import {
  delegatedChildSource,
  dispatchThreadAttributionRepair,
  recordSourceParticipant,
  withCommandSource,
} from "./sourceAttribution.ts";

const source: SourceRef = {
  channel: "web",
  personId: PersonId.make("ada"),
  username: IdentityUsername.make("ada"),
};
const other: SourceRef = {
  channel: "discord",
  personId: PersonId.make("grace"),
  username: IdentityUsername.make("grace"),
};
const createdAt = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
const threadId = ThreadId.make("thread-1");
const messageId = MessageId.make("message-1");

const thread = (fields: Partial<OrchestrationV2AppThread> = {}) =>
  ({ id: threadId, createdAt, ...fields }) as OrchestrationV2AppThread;

const dispatch = {
  type: "message.dispatch",
  commandId: CommandId.make("command-1"),
  threadId,
  messageId,
  source,
} as unknown as OrchestrationV2ServerCommand;

const event = (value: unknown) => value as Omit<OrchestrationV2DomainEvent, "id">;

const collect = () => {
  const emitted: Array<{ readonly payload: OrchestrationV2AppThread }> = [];
  const emit = (value: unknown) =>
    Effect.sync(() => {
      emitted.push(value as { readonly payload: OrchestrationV2AppThread });
    });
  return { emitted, emit };
};

describe("withCommandSource", () => {
  it("stamps only the dispatched user message", () => {
    const own = withCommandSource(
      dispatch,
      event({ type: "message.updated", payload: { id: messageId, role: "user" } }),
    );
    const unrelated = withCommandSource(
      dispatch,
      event({ type: "message.updated", payload: { id: MessageId.make("other"), role: "user" } }),
    );
    expect((own.payload as { source?: SourceRef }).source).toEqual(source);
    expect((unrelated.payload as { source?: SourceRef }).source).toBeUndefined();
  });

  it("records a created thread's origin as its first participant", () => {
    const created = withCommandSource(
      { type: "thread.create", originSource: source } as unknown as OrchestrationV2ServerCommand,
      event({ type: "thread.created", payload: thread() }),
    );
    const payload = created.payload as OrchestrationV2AppThread;
    expect(payload.originSource).toEqual(source);
    expect(payload.participantSummaries?.map(({ personId }) => personId)).toEqual(["ada"]);
  });
});

describe("recordSourceParticipant", () => {
  it.effect("adds a sender to the participants without replacing the origin", () =>
    Effect.gen(function* () {
      const { emitted, emit } = collect();
      const result = yield* recordSourceParticipant(
        { source: other },
        { thread: thread({ originSource: source }) },
        emit,
      );
      expect(result.thread.originSource).toEqual(source);
      expect(result.thread.participantSummaries?.map(({ personId }) => personId)).toContain(
        "grace",
      );
      expect(emitted).toHaveLength(1);
    }),
  );

  it.effect("emits nothing for an unattributed message", () =>
    Effect.gen(function* () {
      const { emitted, emit } = collect();
      yield* recordSourceParticipant({}, { thread: thread() }, emit);
      expect(emitted).toHaveLength(0);
    }),
  );
});

describe("dispatchThreadAttributionRepair", () => {
  const repair = {
    type: "thread.attribution.repair" as const,
    commandId: CommandId.make("repair-1"),
    threadId,
    source,
  };

  it.effect("attributes an unattributed thread", () =>
    Effect.gen(function* () {
      const { emitted, emit } = collect();
      yield* dispatchThreadAttributionRepair(repair, thread(), emit);
      expect(emitted[0]?.payload.originSource).toMatchObject({ personId: "ada" });
    }),
  );

  it.effect("leaves a thread attributed to someone else alone", () =>
    Effect.gen(function* () {
      const { emitted, emit } = collect();
      yield* dispatchThreadAttributionRepair(repair, thread({ originSource: other }), emit);
      expect(emitted).toHaveLength(0);
    }),
  );
});

it("hands a delegated child its parent's person only", () => {
  expect(delegatedChildSource(thread({ originSource: source }))).toEqual({ source });
  expect(delegatedChildSource(thread({ originSource: { channel: "bot" } }))).toEqual({});
});
