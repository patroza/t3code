import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type PreviewAutomationError,
  type PreviewAutomationHost,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as ForkPreviewAutomationHost from "./forkPreviewAutomationHost.ts";

const environmentId = EnvironmentId.make("environment-1");

const scopeFor = (threadId: string) => ({
  environmentId,
  requestNamespace: `provider-session-${threadId}`,
  thread: {
    threadId: ThreadId.make(threadId),
    providerSessionId: `provider-session-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
});

const testLayer = ForkPreviewAutomationHost.layer.pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

/** Answers every request with `{ servedBy: clientId }`; resolves to the connection id. */
const serve = Effect.fn("test.serve")(function* (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  host: PreviewAutomationHost,
  respond: (response: PreviewAutomationResponse) => Effect.Effect<void, PreviewAutomationError>,
) {
  const connected = yield* Deferred.make<string>();
  yield* Stream.runForEach(events, (event) =>
    event.type === "connected"
      ? Deferred.succeed(connected, event.connectionId)
      : respond({
          clientId: host.clientId,
          connectionId: event.connectionId,
          requestId: event.request.requestId,
          ok: true,
          result: { servedBy: host.clientId },
        }).pipe(Effect.ignore),
  ).pipe(Effect.forkScoped);
  return yield* Deferred.await(connected);
});

const invokeStatus = (
  broker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  thread: string,
) =>
  broker.invoke<{ readonly servedBy: string }>({
    scope: scopeFor(thread),
    operation: "status",
    input: {},
  });

const botHost: PreviewAutomationHost = {
  clientId: "discord-browser-default",
  environmentId,
  supportedOperations: ["status", "open", "snapshot"],
};

it.effect("an external host connects over the fork service and serves a claimed thread", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const hosts = yield* ForkPreviewAutomationHost.PreviewAutomationExternalHosts;
    const connectionId = yield* serve(yield* hosts.connect(botHost), botHost, hosts.respond);
    yield* hosts.focusHost({
      clientId: botHost.clientId,
      environmentId,
      connectionId,
      focused: true,
      threadId: ThreadId.make("thread-bot"),
    });

    expect(yield* invokeStatus(broker, "thread-bot")).toEqual({
      servedBy: "discord-browser-default",
    });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("a claimed thread routes to its host while other threads keep the default host", () =>
  Effect.gen(function* () {
    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const hosts = yield* ForkPreviewAutomationHost.PreviewAutomationExternalHosts;
    const defaultHost: PreviewAutomationHost = { clientId: "server-browser", environmentId };
    yield* serve(
      yield* broker.connect(defaultHost, { preferred: true }),
      defaultHost,
      broker.respond,
    );
    const connectionId = yield* serve(yield* hosts.connect(botHost), botHost, hosts.respond);
    const claim = {
      clientId: botHost.clientId,
      environmentId,
      connectionId,
      threadId: ThreadId.make("thread-bot"),
    };

    yield* hosts.focusHost({ ...claim, focused: true });
    expect(yield* invokeStatus(broker, "thread-bot")).toEqual({
      servedBy: "discord-browser-default",
    });
    expect(yield* invokeStatus(broker, "thread-desktop")).toEqual({ servedBy: "server-browser" });

    yield* hosts.focusHost({ ...claim, focused: false });
    expect(yield* invokeStatus(broker, "thread-bot")).toEqual({ servedBy: "server-browser" });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
