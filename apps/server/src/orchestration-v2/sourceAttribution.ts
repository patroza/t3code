import {
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type SourceRef,
  type ThreadAttributionRepairCommand,
  ThreadParticipantSummary,
} from "@t3tools/contracts";
import {
  mergeParticipantSummaries,
  originParticipantSummary,
} from "@t3tools/shared/sourceAttribution";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { applyStoredThreadAttribution } from "../identity/applyThreadAttribution.ts";
import { makeIdentityMapPeopleReader } from "../identity/IdentityService.ts";

/** Identity hooks for the orchestrator: commands carry a server-stamped source; events record it. */

const decodeParticipantSummaries = Schema.decodeUnknownSync(
  Schema.Array(ThreadParticipantSummary),
);

type UnidentifiedEvent = OrchestrationV2DomainEvent extends infer Event
  ? Event extends OrchestrationV2DomainEvent
    ? Omit<Event, "id">
    : never
  : never;
type EmitThreadUpdate<E, R> = (event: {
  readonly type: "thread.metadata-updated";
  readonly threadId: OrchestrationV2AppThread["id"];
  readonly occurredAt: DateTime.Utc;
  readonly payload: OrchestrationV2AppThread;
}) => Effect.Effect<unknown, E, R>;

/**
 * `emit` hook. A dispatched user message and its turn item record the dispatch's source,
 * and a created thread records its origin as the first participant.
 */
export function withCommandSource<Event>(command: OrchestrationV2ServerCommand, input: Event): Event {
  // `emit` is generic over one event type; narrow on the distributed union and hand back that type.
  const event = input as UnidentifiedEvent;
  if (command.type === "message.dispatch" && command.source !== undefined) {
    const source = command.source;
    if (
      event.type === "message.updated" &&
      event.payload.role === "user" &&
      event.payload.id === command.messageId &&
      event.payload.source === undefined
    ) {
      return { ...event, payload: { ...event.payload, source } } as Event;
    }
    if (
      event.type === "turn-item.updated" &&
      event.payload.type === "user_message" &&
      event.payload.messageId === command.messageId &&
      event.payload.source === undefined
    ) {
      return { ...event, payload: { ...event.payload, source } } as Event;
    }
    return input;
  }
  if (
    command.type === "thread.create" &&
    command.originSource !== undefined &&
    event.type === "thread.created" &&
    event.payload.originSource === undefined
  ) {
    const participant = originParticipantSummary(
      command.originSource,
      DateTime.formatIso(event.payload.createdAt),
    );
    return {
      ...event,
      payload: {
        ...event.payload,
        originSource: command.originSource,
        ...(participant === undefined ? {} : { participantSummaries: [participant] }),
      },
    } as Event;
  }
  return input;
}

/** `dispatchMessage` hook: a sender joins the thread's participants (and becomes its origin if it has none). */
export const recordSourceParticipant = Effect.fn("Orchestrator.recordSourceParticipant")(
  function* <Projection extends Pick<OrchestrationV2ThreadProjection, "thread">, E, R>(
    command: { readonly source?: SourceRef | undefined },
    projection: Projection,
    emitThreadUpdate: EmitThreadUpdate<E, R>,
  ) {
    if (command.source === undefined) return projection;
    const now = yield* DateTime.now;
    const thread: OrchestrationV2AppThread = {
      ...projection.thread,
      originSource: projection.thread.originSource ?? command.source,
      participantSummaries: decodeParticipantSummaries(
        mergeParticipantSummaries({
          existing: projection.thread.participantSummaries ?? [],
          source: command.source,
          participatedAt: DateTime.formatIso(now),
          originPersonId: projection.thread.originSource?.personId,
        }),
      ),
    };
    yield* emitThreadUpdate({
      type: "thread.metadata-updated",
      threadId: thread.id,
      occurredAt: now,
      payload: thread,
    });
    return { ...projection, thread };
  },
);

/** A delegated child inherits its parent's person, so the child is attributed to the same human. */
export function delegatedChildSource(parent: OrchestrationV2AppThread): {
  readonly source?: SourceRef;
} {
  const origin = parent.originSource;
  return origin != null && origin.personId !== undefined ? { source: origin } : {};
}

/** `thread.attribution.repair`: never overwrites a thread already attributed to someone else. */
export const dispatchThreadAttributionRepair = Effect.fn("Orchestrator.repairThreadAttribution")(
  function* <E, R>(
    command: typeof ThreadAttributionRepairCommand.Type,
    thread: OrchestrationV2AppThread,
    emitThreadUpdate: EmitThreadUpdate<E, R>,
  ) {
    if (thread.originSource?.personId != null && thread.originSource.personId !== command.source.personId) {
      return;
    }
    yield* emitThreadUpdate({
      type: "thread.metadata-updated",
      threadId: thread.id,
      occurredAt: yield* DateTime.now,
      payload: {
        ...thread,
        originSource: { ...thread.originSource, ...command.source },
        participantSummaries: decodeParticipantSummaries(
          mergeParticipantSummaries({
            existing: thread.participantSummaries ?? [],
            source: command.source,
            participatedAt: DateTime.formatIso(thread.createdAt),
            originPersonId: command.source.personId,
          }),
        ),
      },
    });
  },
);

/** Shell hook: thread attribution fields, present only when set. */
export function threadAttributionFields(thread: OrchestrationV2AppThread): {
  readonly originSource?: OrchestrationV2AppThread["originSource"];
  readonly participantSummaries?: OrchestrationV2AppThread["participantSummaries"];
} {
  return {
    ...(thread.originSource === undefined ? {} : { originSource: thread.originSource }),
    ...(thread.participantSummaries === undefined
      ? {}
      : { participantSummaries: thread.participantSummaries }),
  };
}

let storedAttributionPeople: ReturnType<typeof makeIdentityMapPeopleReader> | undefined;

/**
 * Projection decode hook. Threads stamped while the identity map was empty keep only a platform
 * actor; resolve it against the current map so ownership filters and labels see the person.
 */
export const withStoredThreadAttribution =
  <E, R>(decode: (payload: unknown) => Effect.Effect<OrchestrationV2AppThread, E, R>) =>
  (payload: unknown) =>
    decode(payload).pipe(
      Effect.flatMap((thread) =>
        Effect.suspend(() => (storedAttributionPeople ??= makeIdentityMapPeopleReader())).pipe(
          Effect.map((people) => ({
            ...thread,
            ...applyStoredThreadAttribution(
              {
                originSource: thread.originSource,
                participantSummaries: thread.participantSummaries,
                createdAt: DateTime.formatIso(thread.createdAt),
              },
              people,
            ),
          })),
        ),
      ),
    );
