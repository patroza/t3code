import { Effect, Layer, Queue, Stream } from "effect";
import { ExchangeRepository, inMemoryExchangeRepository } from "./ExchangeRepository.ts";
import { makeNTBSProcessor, type NTBSProcessor } from "./processor.ts";
import { MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { T3Gateway } from "./t3gateway.ts";
import { NTBSAdapter } from "./adapter.ts";
import type { WorkCoordinates } from "./exchange.ts";

/**
 * The test configuration of the services.
 * While T3Gateway tests took flags as input (failX?: boolean, etc), this does not scale for processor test, because instead of a single call we're often testing an entire choreography of events and how the processor behaves in that situation.
 *
 * Flags, on the other hand, work when behaviors are small, enumerable and reused. Scripts pay off for testing choreography.
 */
type ServiceInput = {
  readonly t3Gateway?: Partial<T3Gateway>;
  readonly adapter?: Partial<NTBSAdapter>;
};

type Call = {
  service: string;
  method: string;
  args: ReadonlyArray<unknown>;
};

/**
 * Everything the test harness hands back to the file.
 *
 * The assembled service as well as probes to look into its state.
 */
type ProcessorTestContext = {
  /** The subject under test, built from mocked services.*/
  readonly processor: NTBSProcessor;
  /** Assesses the persisted state in most of the tests. What has been recorded about the events and changes? */
  readonly repository: ExchangeRepository;
  /** The shared ordered call log. We know what has been dispatched and with which arguments. This is not testing internals but actual business-logic. */
  readonly calls: ReadonlyArray<Call>;
  /** Pushes a threadId to the `threadActivity` stream, waking up the processor. */
  readonly pingActivity: (threadId: ThreadId) => Effect.Effect<void>;
};

const defaultProjectId = ProjectId.make("defaultProjectId");
const defaultThreadId = ThreadId.make("defaultThreadId");
const defaultUserMessageId = MessageId.make("defaultUserMessageId");

const defaultWorkCoordinates: WorkCoordinates = {
  projectId: defaultProjectId,
  startBranchName: "fork/dev",
  startCommitSha: "start-commit-sha",
  threadId: defaultThreadId,
  userMessageId: defaultUserMessageId,
  worktreeBranchName: "ntbs/defaultThreadId",
};

const postedReplyUri = "test://reply/1";

/**
 * Happy-path defaults:
 * - fresh request flowing to a started turn
 * - nothing settled yet
 * - replies deliverable
 *
 * Each test overrides only the methods its scenario changes.
 */
const defaultT3Gateway: Omit<T3Gateway, "threadActivity"> = {
  planCoordinates: () => Effect.succeed(defaultWorkCoordinates),
  getThreadStatus: () => Effect.succeed({ thread: "missing" }),
  provisionThread: () => Effect.void,
  getTurnStatus: () => Effect.succeed({ turn: "missing" }),
  startTurn: () => Effect.void,
};

const defaultAdapter: NTBSAdapter = {
  acknowledge: () => Effect.void,
  postReply: () => Effect.succeed(postedReplyUri),
  findPostedReply: () => Effect.succeed(null),
};

/**
 * The harness.
 *
 * The term "harness" comes from electrical engineering for describing hardware test benches: the wiring harness is the fixed rig that holds the device under test and connects it to instruments, so each experiment only varies the stimulus.
 *
 * In software it means the same thing: the _fixed_ part of the test setup such as system assembly, instrumentation, probes, as opposed to fixtures (the data) and tests (the scenarios).
 *
 * `withProcessor` is our harness.
 *
 * <A, E> generics allow for our test callback to pass through its types.
 * We never specify A and E manually, and we rarely care, but if we ever have to chain the result of withProcessor or do anything with its returned value they are useful to avoid spreading `any`s.
 */
const withProcessor = <A, E>(
  servicesInput: ServiceInput,
  test: (context: ProcessorTestContext) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const calls: Call[] = [];
    const activity = yield* Queue.unbounded<ThreadId>();

    /**
     * Records the call, then runs the wrapped behavior.
     * Recording lives here so no implementation or override can forget it.
     * The push happens when the effect runs, not when it's created, which keeps the log ordering honest in the concurrency tests.
     */
    const wrap =
      (service: string) =>
      <Args extends ReadonlyArray<unknown>, B, E2>(
        method: string,
        fn: (...args: Args) => Effect.Effect<B, E2>,
      ) =>
      (...args: Args) =>
        Effect.suspend(() => {
          calls.push({ service, method, args });
          return fn(...args);
        });

    const wrapT3 = wrap("T3Gateway");
    const wrapAdapter = wrap("NTBSAdapter");

    const t3 = { ...defaultT3Gateway, ...servicesInput.t3Gateway };
    const adapter = { ...defaultAdapter, ...servicesInput.adapter };

    const layer = Layer.mergeAll(
      Layer.mock(T3Gateway, {
        planCoordinates: wrapT3("planCoordinates", t3.planCoordinates),
        getThreadStatus: wrapT3("getThreadStatus", t3.getThreadStatus),
        getTurnStatus: wrapT3("getTurnStatus", t3.getTurnStatus),
        provisionThread: wrapT3("provisionThread", t3.provisionThread),
        startTurn: wrapT3("startTurn", t3.startTurn),
        threadActivity: Stream.fromQueue(activity),
      }),
      Layer.mock(NTBSAdapter, {
        acknowledge: wrapAdapter("acknowledge", adapter.acknowledge),
        findPostedReply: wrapAdapter("findPostedReply", adapter.findPostedReply),
        postReply: wrapAdapter("postReply", adapter.postReply),
      }),
      inMemoryExchangeRepository,
    );

    return yield* Effect.gen(function* () {
      const processor = yield* makeNTBSProcessor;
      const repository = yield* ExchangeRepository;

      return yield* test({
        processor,
        repository,
        calls,
        pingActivity: (threadId) => Queue.offer(activity, threadId).pipe(Effect.asVoid),
      });
    }).pipe(Effect.provide(layer));
  });
