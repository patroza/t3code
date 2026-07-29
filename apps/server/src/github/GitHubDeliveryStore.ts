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

export const GitHubDelivery = Schema.Struct({
  deliveryId: Schema.String,
  installationId: Schema.Number,
  repository: Schema.String,
  pullRequestNumber: Schema.Number,
  sourceCommentId: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  /**
   * Where the source mention lived and where responses are posted.
   * - `issue`: PR conversation comment (Issues API)
   * - `review`: inline Files-changed review comment (Pulls review-comment API)
   */
  commentSurface: Schema.Literals(["issue", "review"]).pipe(
    Schema.withDecodingDefault(Effect.succeed("issue" as const)),
  ),
  /**
   * Review-thread parent for replies (top-level review comment id). Defaults to
   * `sourceCommentId` for legacy deliveries and issue-surface comments.
   */
  replyToCommentId: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  acknowledgmentReactionId: Schema.NullOr(Schema.Number).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  responseCommentId: Schema.NullOr(Schema.Number),
  threadId: Schema.NullOr(Schema.String),
  previousTurnId: Schema.NullOr(Schema.String),
  /** User message id dispatched for this delivery (stable anchor across restarts). */
  userMessageId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  /**
   * Turn id this delivery is waiting to finalize. Discovered once assistants appear for the
   * dispatched user message; preferred over `latestTurn` which can move or go null.
   */
  targetTurnId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  status: Schema.Literals(["received", "processing", "completed", "rejected"]),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
export type StoredGitHubDelivery = {
  readonly deliveryId: string;
  readonly installationId: number;
  readonly repository: string;
  readonly pullRequestNumber: number;
  readonly sourceCommentId: number;
  readonly commentSurface: "issue" | "review";
  readonly replyToCommentId: number;
  readonly acknowledgmentReactionId: number | null;
  readonly responseCommentId: number | null;
  readonly threadId: ThreadId | null;
  readonly previousTurnId: TurnId | null;
  readonly userMessageId: string | null;
  readonly targetTurnId: TurnId | null;
  readonly status: "received" | "processing" | "completed" | "rejected";
  readonly createdAt: string;
  readonly updatedAt: string;
};

const decodeDeliveries = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Array(GitHubDelivery)),
);

export class GitHubDeliveryStore extends Context.Service<
  GitHubDeliveryStore,
  {
    readonly get: (deliveryId: string) => Effect.Effect<StoredGitHubDelivery | null>;
    readonly claim: (delivery: StoredGitHubDelivery) => Effect.Effect<boolean>;
    readonly put: (delivery: StoredGitHubDelivery) => Effect.Effect<void>;
    readonly listProcessing: () => Effect.Effect<ReadonlyArray<StoredGitHubDelivery>>;
    /**
     * Most recent delivery that bound a T3 thread to a GitHub inline review discussion
     * (keyed by review root comment id / replyToCommentId).
     */
    readonly findLatestReviewThreadAssignment: (input: {
      readonly repository: string;
      readonly pullRequestNumber: number;
      readonly reviewRootCommentId: number;
    }) => Effect.Effect<StoredGitHubDelivery | null>;
  }
>()("t3/github/GitHubDeliveryStore") {}

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "github-webhook-deliveries.json");
  const initial = yield* fileSystem.readFileString(filePath).pipe(
    Effect.map((raw) => {
      try {
        return decodeDeliveries(raw).map((delivery): StoredGitHubDelivery => {
          // Older deliveries lack replyToCommentId; fall back to the source comment.
          const replyToCommentId =
            delivery.replyToCommentId > 0 ? delivery.replyToCommentId : delivery.sourceCommentId;
          return {
            ...delivery,
            replyToCommentId,
            threadId: delivery.threadId as ThreadId | null,
            previousTurnId: delivery.previousTurnId as TurnId | null,
            targetTurnId: delivery.targetTurnId as TurnId | null,
          };
        });
      } catch {
        return [];
      }
    }),
    Effect.orElseSucceed((): StoredGitHubDelivery[] => []),
  );
  const state = yield* Ref.make(
    new Map(initial.map((delivery) => [delivery.deliveryId, delivery])),
  );
  const lock = yield* Semaphore.make(1);

  const persist = (deliveries: ReadonlyMap<string, StoredGitHubDelivery>) => {
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

  return GitHubDeliveryStore.of({
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
    findLatestReviewThreadAssignment: (input) =>
      Ref.get(state).pipe(
        Effect.map((deliveries) => {
          const expectedRepo = input.repository.trim().toLowerCase();
          const rootId = input.reviewRootCommentId;
          const matches = [...deliveries.values()]
            .filter(
              (delivery) =>
                delivery.commentSurface === "review" &&
                delivery.threadId !== null &&
                delivery.pullRequestNumber === input.pullRequestNumber &&
                delivery.repository.trim().toLowerCase() === expectedRepo &&
                (delivery.replyToCommentId > 0
                  ? delivery.replyToCommentId
                  : delivery.sourceCommentId) === rootId,
            )
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
          return matches[0] ?? null;
        }),
      ),
  });
});

export const layer = Layer.effect(GitHubDeliveryStore, make);
