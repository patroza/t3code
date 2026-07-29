import type { ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";

const MAX_DELIVERIES = 2_000;

export const JiraDelivery = Schema.Struct({
  deliveryId: Schema.String,
  issueKey: Schema.String,
  projectKey: Schema.String,
  sourceCommentId: Schema.String,
  replyToCommentId: Schema.String,
  commentSurface: Schema.Literals(["issue", "reply"]),
  responseCommentId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  previousTurnId: Schema.NullOr(Schema.String),
  userMessageId: Schema.NullOr(Schema.String),
  targetTurnId: Schema.NullOr(Schema.String),
  status: Schema.Literals(["received", "processing", "completed", "rejected"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

export type StoredJiraDelivery = {
  readonly deliveryId: string;
  readonly issueKey: string;
  readonly projectKey: string;
  readonly sourceCommentId: string;
  readonly replyToCommentId: string;
  readonly commentSurface: "issue" | "reply";
  readonly responseCommentId: string | null;
  readonly threadId: ThreadId | null;
  readonly previousTurnId: TurnId | null;
  readonly userMessageId: string | null;
  readonly targetTurnId: TurnId | null;
  readonly status: "received" | "processing" | "completed" | "rejected";
  readonly createdAt: string;
  readonly updatedAt: string;
};

const decodeDeliveries = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(JiraDelivery)),
);

export class JiraDeliveryStore extends Context.Service<
  JiraDeliveryStore,
  {
    readonly get: (deliveryId: string) => Effect.Effect<StoredJiraDelivery | null>;
    readonly claim: (delivery: StoredJiraDelivery) => Effect.Effect<boolean>;
    readonly put: (delivery: StoredJiraDelivery) => Effect.Effect<void>;
    readonly listProcessing: () => Effect.Effect<ReadonlyArray<StoredJiraDelivery>>;
  }
>()("t3/jira/JiraDeliveryStore") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "jira-webhook-deliveries.json");
  const initial = yield* fileSystem.readFileString(filePath).pipe(
    Effect.map((raw) => {
      try {
        return decodeDeliveries(raw).map(
          (delivery): StoredJiraDelivery => ({
            ...delivery,
            threadId: delivery.threadId as ThreadId | null,
            previousTurnId: delivery.previousTurnId as TurnId | null,
            targetTurnId: delivery.targetTurnId as TurnId | null,
          }),
        );
      } catch {
        return [];
      }
    }),
    Effect.orElseSucceed((): StoredJiraDelivery[] => []),
  );
  const state = yield* Ref.make(
    new Map(initial.map((delivery) => [delivery.deliveryId, delivery])),
  );
  const lock = yield* Semaphore.make(1);

  const persist = (deliveries: ReadonlyMap<string, StoredJiraDelivery>) => {
    const retained = [...deliveries.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_DELIVERIES);
    return writeFileStringAtomically({
      filePath,
      contents: `${JSON.stringify(retained, null, 2)}\n`,
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.orDie,
    );
  };

  return JiraDeliveryStore.of({
    get: (deliveryId) =>
      Ref.get(state).pipe(Effect.map((deliveries) => deliveries.get(deliveryId) ?? null)),
    claim: (delivery) =>
      lock.withPermit(
        Effect.gen(function* () {
          const claimed = yield* Ref.modify(state, (deliveries) => {
            if (deliveries.has(delivery.deliveryId)) return [false, deliveries] as const;
            const updated = new Map(deliveries);
            updated.set(delivery.deliveryId, delivery);
            return [true, updated] as const;
          });
          if (claimed) yield* persist(yield* Ref.get(state));
          return claimed;
        }),
      ),
    put: (delivery) =>
      lock.withPermit(
        Effect.gen(function* () {
          const next = yield* Ref.updateAndGet(state, (deliveries) => {
            const updated = new Map(deliveries);
            updated.set(delivery.deliveryId, delivery);
            return updated;
          });
          yield* persist(next);
        }),
      ),
    listProcessing: () =>
      Ref.get(state).pipe(
        Effect.map((deliveries) =>
          [...deliveries.values()].filter((delivery) => delivery.status === "processing"),
        ),
      ),
  });
});

export const layer = Layer.effect(JiraDeliveryStore, make);
