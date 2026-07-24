/**
 * AiUsageMonitor - polls the local `ai-usage` daemon and fans snapshots out.
 *
 * A user-run daemon (`ai-usage serve`, default `http://127.0.0.1:8787`) exposes
 * a `/dms` endpoint with normalized coding-plan usage across providers. This
 * service polls it on an interval and broadcasts the latest snapshot to
 * subscribers so the web can mark providers near/over their limits.
 *
 * The daemon is optional: any fetch/parse failure yields `AI_USAGE_UNAVAILABLE`
 * (available: false, no items) rather than an error, so the feature degrades to
 * "no markers" when the daemon isn't running.
 *
 * Polling is reference-counted via scoped `retain`, mirroring PortScanner: a
 * single layer-scoped fiber polls forever, but each tick is a no-op when the
 * retain count is zero.
 */
import {
  AI_USAGE_UNAVAILABLE,
  AiUsageProviderStatus,
  type AiUsageSnapshot,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

export class AiUsageMonitor extends Context.Service<
  AiUsageMonitor,
  {
    readonly current: () => Effect.Effect<AiUsageSnapshot>;
    readonly subscribe: (
      listener: (snapshot: AiUsageSnapshot) => Effect.Effect<void>,
    ) => Effect.Effect<void, never, Scope.Scope>;
    readonly retain: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/aiUsage/AiUsageMonitor") {}

const POLL_INTERVAL = Duration.seconds(60);
const REQUEST_TIMEOUT = Duration.seconds(10);

const DEFAULT_BASE_URL = "http://127.0.0.1:8787";
const resolveBaseUrl = (): string => {
  const configured = process.env.AI_USAGE_URL?.trim();
  return (configured && configured.length > 0 ? configured : DEFAULT_BASE_URL).replace(/\/+$/u, "");
};

// The daemon feed has no `available` flag; we add it when constructing the
// snapshot. Reusing `AiUsageProviderStatus` avoids re-declaring the item shape.
const AiUsageFeed = Schema.Struct({
  generated_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  worst_percent: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  items: Schema.Array(AiUsageProviderStatus),
});

type Listener = (snapshot: AiUsageSnapshot) => Effect.Effect<void>;

interface MonitorState {
  readonly lastSnapshot: AiUsageSnapshot;
  readonly listeners: ReadonlySet<Listener>;
  readonly retainCount: number;
}

export const make = Effect.gen(function* AiUsageMonitorMake() {
  const httpClient = yield* HttpClient.HttpClient;
  const baseUrl = resolveBaseUrl();
  const stateRef = yield* Ref.make<MonitorState>({
    lastSnapshot: AI_USAGE_UNAVAILABLE,
    listeners: new Set(),
    retainCount: 0,
  });

  const fetchSnapshot = HttpClientRequest.get(`${baseUrl}/dms`).pipe(
    HttpClientRequest.acceptJson,
    httpClient.execute,
    Effect.flatMap(HttpClientResponse.schemaBodyJson(AiUsageFeed)),
    Effect.timeout(REQUEST_TIMEOUT),
    Effect.map(
      (feed): AiUsageSnapshot => ({
        generated_at: feed.generated_at ?? null,
        worst_percent: feed.worst_percent ?? null,
        available: true,
        items: feed.items,
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logDebug("ai-usage daemon unavailable", Cause.pretty(cause)).pipe(
        Effect.as(AI_USAGE_UNAVAILABLE),
      ),
    ),
  );

  const broadcast = Effect.fn("AiUsageMonitor.broadcast")(function* (snapshot: AiUsageSnapshot) {
    const listeners = (yield* Ref.get(stateRef)).listeners;
    yield* Effect.forEach(listeners, (listener) => listener(snapshot), { discard: true });
  });

  const pollTick = Effect.fn("AiUsageMonitor.pollTick")(
    function* () {
      if ((yield* Ref.get(stateRef)).retainCount <= 0) return;
      const next = yield* fetchSnapshot;
      const changed = yield* Ref.modify(stateRef, (state) =>
        snapshotsEqual(state.lastSnapshot, next)
          ? [false, state]
          : [true, { ...state, lastSnapshot: next }],
      );
      if (changed) yield* broadcast(next);
    },
    Effect.catchCause((cause: Cause.Cause<never>) =>
      Effect.logWarning("ai-usage poll failed", Cause.pretty(cause)),
    ),
  );

  // Single layer-scoped polling fiber; ticks are no-ops when unretained.
  yield* Effect.forkScoped(pollTick().pipe(Effect.repeat(Schedule.spaced(POLL_INTERVAL))));

  const acquireRetention = Effect.fn("AiUsageMonitor.retain")(function* () {
    const wasIdle = yield* Ref.modify(stateRef, (state) => [
      state.retainCount === 0,
      { ...state, retainCount: state.retainCount + 1 },
    ]);
    if (wasIdle) yield* pollTick();
  });

  const retain: AiUsageMonitor["Service"]["retain"] = Effect.acquireRelease(
    acquireRetention(),
    () =>
      Ref.update(stateRef, (state) => ({
        ...state,
        retainCount: Math.max(0, state.retainCount - 1),
      })),
  );

  const subscribe: AiUsageMonitor["Service"]["subscribe"] = Effect.fn("AiUsageMonitor.subscribe")(
    (listener) =>
      Effect.acquireRelease(
        Ref.update(stateRef, (state) => ({
          ...state,
          listeners: new Set([...state.listeners, listener]),
        })),
        () =>
          Ref.update(stateRef, (state) => {
            const listeners = new Set(state.listeners);
            listeners.delete(listener);
            return { ...state, listeners };
          }),
      ),
  );

  const current: AiUsageMonitor["Service"]["current"] = () =>
    Ref.get(stateRef).pipe(Effect.map((state) => state.lastSnapshot));

  return AiUsageMonitor.of({ current, subscribe, retain });
}).pipe(Effect.withSpan("AiUsageMonitor.make"));

const snapshotsEqual = (left: AiUsageSnapshot, right: AiUsageSnapshot): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export const layer = Layer.effect(AiUsageMonitor, make);
