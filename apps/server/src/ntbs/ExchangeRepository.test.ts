import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  ExchangeRepositoryError,
  ExchangeRepositoryTag,
  inMemoryExchangeRepository,
} from "./ExchangeRepository.ts";
import {
  makeRequestClaimed,
  toReplyPending,
  toReplyPosted,
  toThreadCreated,
  toUndeliverable,
} from "./exchange.ts";

const makeExchange = (sourceUri: string, threadId: string) =>
  makeRequestClaimed({
    sourceUri,
    snapshot: "request",
    attachments: [],
    t3: {
      projectId: ProjectId.make("project"),
      baseRef: "main",
      threadId: ThreadId.make(threadId),
      userMessageId: MessageId.make(`message-${threadId}`),
      branchName: `branch-${threadId}`,
    },
  });

describe("inMemoryExchangeRepository", () => {
  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("allows the same sourceUri to replace its state", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepositoryTag;
        const claimed = makeExchange("test://request/1", "thread-1");
        const threadCreated = toThreadCreated(claimed);

        yield* repository.upsert(claimed);
        yield* repository.upsert(threadCreated);

        expect(yield* repository.findBySourceUri(claimed.sourceUri)).toEqual(threadCreated);
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("rejects a threadId already owned by another sourceUri", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepositoryTag;
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
    it.effect("finds an exchange by threadId", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepositoryTag;
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
        const repository = yield* ExchangeRepositoryTag;
        const claimed = makeExchange("test://request/claimed", "thread-claimed");
        const threadCreated = toThreadCreated(
          makeExchange("test://request/thread-created", "thread-created"),
        );
        const replyPending = toReplyPending(
          toThreadCreated(makeExchange("test://request/reply-pending", "thread-reply-pending")),
          { type: "answer", text: "pending reply" },
        );
        const replyPosted = toReplyPosted(
          toReplyPending(
            toThreadCreated(makeExchange("test://request/reply-posted", "thread-reply-posted")),
            { type: "answer", text: "posted reply" },
          ),
          "test://reply/posted",
        );
        const undeliverable = toUndeliverable(
          toReplyPending(
            toThreadCreated(makeExchange("test://request/undeliverable", "thread-undeliverable")),
            { type: "failure", text: "undeliverable reply" },
          ),
          { message: "platform rejected the reply" },
        );

        yield* Effect.forEach(
          [claimed, threadCreated, replyPending, replyPosted, undeliverable],
          repository.upsert,
        );

        const results = yield* repository.findNonTerminalExchanges;

        expect(results).toHaveLength(3);
        expect(results).toEqual(expect.arrayContaining([claimed, threadCreated, replyPending]));
      }),
    );
  });

  it.layer(inMemoryExchangeRepository)((it) => {
    it.effect("preserves existing records when a replacement has a conflicting threadId", () =>
      Effect.gen(function* () {
        const repository = yield* ExchangeRepositoryTag;
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
        const repository = yield* ExchangeRepositoryTag;
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
