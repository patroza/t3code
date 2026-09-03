import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { MessageId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import {
  ExchangeRepositoryError,
  ExchangeRepository,
  inMemoryExchangeRepository,
} from "./ExchangeRepository.ts";
import {
  makeRequestAccepted,
  toReplyPending,
  toReplyPosted,
  toThreadCreated,
  toUndeliverable,
  toWorkPlanned,
  type Reply,
} from "./exchange.ts";

const now = 1_700_000_000_000;

const makeAccepted = (sourceUri: string) =>
  makeRequestAccepted(
    { sourceUri, snapshot: "request", attachments: [] },
    { projectId: ProjectId.make("project"), startBranchName: "main" },
    now,
  );

const makeExchange = (sourceUri: string, threadId: string) =>
  toWorkPlanned(
    makeAccepted(sourceUri),
    {
      projectId: ProjectId.make("project"),
      startBranchName: "main",
      startCommitSha: "start-commit-sha",
      threadId: ThreadId.make(threadId),
      userMessageId: MessageId.make(`message-${threadId}`),
      worktreeBranchName: `branch-${threadId}`,
    },
    now,
  );

const answerFrom = (threadId: string, text: string): Reply => ({
  type: "answer",
  text,
  threadId: ThreadId.make(threadId),
  userMessageId: MessageId.make(`message-${threadId}`),
  turnId: TurnId.make(`turn-${threadId}`),
});

describe("inMemoryExchangeRepository", () => {
  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("allows the same sourceUri to advance its state", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepository;
        const planned = makeExchange("test://request/1", "thread-1");
        const threadCreated = toThreadCreated(planned, now);

        yield* repository.upsert(planned);
        yield* repository.upsert(threadCreated);

        expect(yield* repository.findBySourceUri(planned.sourceUri)).toEqual(threadCreated);
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("allows the same state to be rewritten", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepository;
        const planned = makeExchange("test://request/1", "thread-1");

        yield* repository.upsert(planned);
        yield* repository.upsert(planned);

        expect(yield* repository.findBySourceUri(planned.sourceUri)).toEqual(planned);
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("refuses a replacement that is not an update of the stored exchange", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepository;
        const planned = makeExchange("test://request/1", "thread-1");
        const threadCreated = toThreadCreated(planned, now);
        const replyPending = toReplyPending(threadCreated, answerFrom("thread-1", "reply"), now);
        const posted = toReplyPosted(replyPending, "test://reply/1", now);

        yield* repository.upsert(threadCreated);
        const backwards = yield* Effect.flip(repository.upsert(planned));
        expect(backwards).toBeInstanceOf(ExchangeRepositoryError);

        const skippingAhead = yield* Effect.flip(repository.upsert(posted));
        expect(skippingAhead).toBeInstanceOf(ExchangeRepositoryError);

        yield* repository.upsert(replyPending);
        yield* repository.upsert(posted);
        const afterTerminal = yield* Effect.flip(repository.upsert(threadCreated));
        expect(afterTerminal).toBeInstanceOf(ExchangeRepositoryError);

        expect(yield* repository.findBySourceUri(planned.sourceUri)).toEqual(posted);
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("rejects a threadId already owned by another sourceUri", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepository;
        const existing = makeExchange("test://request/1", "shared-thread");
        const conflicting = makeExchange("test://request/2", "shared-thread");

        yield* repository.upsert(existing);
        const error = yield* Effect.flip(repository.upsert(conflicting));

        expect(error).toBeInstanceOf(ExchangeRepositoryError);
        expect(error.reason).toContain(existing.t3.threadId);
        expect(yield* repository.findBySourceUri(existing.sourceUri)).toEqual(existing);
        expect(yield* repository.findBySourceUri(conflicting.sourceUri)).toBeNull();
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("keeps a replied exchange's thread out of reach of other sourceUris", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepository;
        const replied = toReplyPending(
          toThreadCreated(makeExchange("test://request/1", "shared-thread"), now),
          answerFrom("shared-thread", "done"),
          now,
        );
        const conflicting = makeExchange("test://request/2", "shared-thread");

        yield* repository.upsert(replied);
        const error = yield* Effect.flip(repository.upsert(conflicting));

        expect(error).toBeInstanceOf(ExchangeRepositoryError);
        expect(yield* repository.findBySourceUri(conflicting.sourceUri)).toBeNull();
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("finds an exchange by threadId", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepository;
        const exchange = makeExchange("test://request/1", "thread-1");

        yield* repository.upsert(exchange);

        expect(yield* repository.findByThreadId(exchange.t3.threadId)).toEqual(exchange);
        expect(yield* repository.findByThreadId(ThreadId.make("unknown-thread"))).toBeNull();
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("finds only non-terminal exchanges", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepository;
        const accepted = makeAccepted("test://request/accepted");
        const planned = makeExchange("test://request/planned", "thread-planned");
        const threadCreated = toThreadCreated(
          makeExchange("test://request/thread-created", "thread-created"),
          now,
        );
        const replyPending = toReplyPending(
          toThreadCreated(
            makeExchange("test://request/reply-pending", "thread-reply-pending"),
            now,
          ),
          answerFrom("thread-reply-pending", "pending reply"),
          now,
        );
        const replyPosted = toReplyPosted(
          toReplyPending(
            toThreadCreated(
              makeExchange("test://request/reply-posted", "thread-reply-posted"),
              now,
            ),
            answerFrom("thread-reply-posted", "posted reply"),
            now,
          ),
          "test://reply/posted",
          now,
        );
        const undeliverable = toUndeliverable(
          toReplyPending(
            toThreadCreated(
              makeExchange("test://request/undeliverable", "thread-undeliverable"),
              now,
            ),
            answerFrom("thread-undeliverable", "undeliverable reply"),
            now,
          ),
          { message: "platform rejected the reply" },
          now,
        );

        yield* Effect.forEach(
          [accepted, planned, threadCreated, replyPending, replyPosted, undeliverable],
          repository.upsert,
        );

        const results = yield* repository.findNonTerminalExchanges;

        expect(results).toHaveLength(4);
        expect(results).toEqual(
          expect.arrayContaining([accepted, planned, threadCreated, replyPending]),
        );
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("preserves existing records when a replacement has a conflicting threadId", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepository;
        const first = makeExchange("test://request/1", "thread-1");
        const second = makeExchange("test://request/2", "thread-2");
        const conflictingReplacement = makeExchange("test://request/2", "thread-1");

        yield* repository.upsert(first);
        yield* repository.upsert(second);
        yield* Effect.flip(repository.upsert(conflictingReplacement));

        expect(yield* repository.findBySourceUri(first.sourceUri)).toEqual(first);
        expect(yield* repository.findBySourceUri(second.sourceUri)).toEqual(second);
        expect(yield* repository.findByThreadId(first.t3.threadId)).toEqual(first);
        expect(yield* repository.findByThreadId(second.t3.threadId)).toEqual(second);
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("atomically rejects concurrent upserts with the same threadId", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepository;
        const first = makeExchange("test://request/1", "shared-thread");
        const second = makeExchange("test://request/2", "shared-thread");

        const outcomes = yield* Effect.all(
          [Effect.exit(repository.upsert(first)), Effect.exit(repository.upsert(second))],
          { concurrency: "unbounded" },
        );

        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1);
        expect(outcomes.filter(Exit.isFailure)).toHaveLength(1);

        const stored = yield* Effect.all([
          repository.findBySourceUri(first.sourceUri),
          repository.findBySourceUri(second.sourceUri),
        ]);

        expect(stored.filter((state) => state !== null)).toHaveLength(1);
      }),
    );
  });
});
