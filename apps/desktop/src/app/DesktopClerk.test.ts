import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { beforeEach, vi } from "vite-plus/test";

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopDeepLinks from "./DesktopDeepLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

const makeDesktopClerkLayer = (isDevelopment = true, isPackaged = false) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    isPackaged,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  return DesktopClerk.layer.pipe(
    Layer.provide(Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment)),
  );
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
  });

  it("derives the Clerk Frontend API hostname used by the desktop CSP", () => {
    const publishableKey = `pk_test_${btoa("clerk.t3.codes$")}`;

    assert.equal(
      DesktopClerk.resolveDesktopClerkFrontendApiHostname(publishableKey),
      "clerk.t3.codes",
    );
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname(""), undefined);
    assert.equal(DesktopClerk.resolveDesktopClerkFrontendApiHostname("invalid"), undefined);
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopClerkLayer()));

      assert.deepEqual(createClerkBridgeMock.mock.calls, [
        [
          {
            storage: storageAdapter,
            passkeys: true,
            renderer: { scheme: "t3code-dev", host: "app" },
          },
        ],
      ]);
      assert.equal(cleanup.mock.calls.length, 1);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(makeDesktopClerkLayer())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, "/tmp/t3-state");
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        'Failed to initialize the desktop Clerk bridge for state directory "/tmp/t3-state" (development: true).',
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(makeDesktopClerkLayer(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, "/tmp/t3-state");
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          'Failed to clean up the desktop Clerk bridge for state directory "/tmp/t3-state" (development: false).',
        );
      }
    });
  });

  it.each([
    { isDevelopment: true, scheme: "t3code-dev" },
    { isDevelopment: false, scheme: "t3code" },
  ])("configures the SDK with the $scheme renderer origin", ({ isDevelopment, scheme }) => {
    const bridge = { cleanup: vi.fn() };
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue(bridge);

    assert.equal(DesktopClerk.createDesktopClerkBridge("/tmp/t3-state", isDevelopment), bridge);
    assert.deepEqual(storageMock.mock.calls, [[{ path: "/tmp/t3-state" }]]);
    assert.deepEqual(createClerkBridgeMock.mock.calls, [
      [
        {
          storage: storageAdapter,
          passkeys: true,
          renderer: { scheme, host: "app" },
        },
      ],
    ]);
    storageMock.mockClear();
    createClerkBridgeMock.mockClear();
  });

  it.effect(
    "wires second-instance argv into deep links and registers the protocol when packaged",
    () => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });

      return Effect.gen(function* () {
        const handledArgv = yield* Ref.make<Array<readonly string[]>>([]);
        const handledUrls = yield* Ref.make<string[]>([]);
        const listeners = new Map<string, (...args: readonly unknown[]) => void>();
        let protocolClientRegistered = false;

        const deepLinksLayer = Layer.succeed(DesktopDeepLinks.DesktopDeepLinks, {
          handleArgv: (argv) =>
            Ref.update(handledArgv, (items) => [...items, argv]).pipe(Effect.asVoid),
          handleUrl: (url) =>
            Ref.update(handledUrls, (items) => [...items, url]).pipe(Effect.asVoid),
          start: Effect.void,
        } satisfies DesktopDeepLinks.DesktopDeepLinks["Service"]);

        const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
          metadata: Effect.die("unexpected metadata"),
          name: Effect.succeed("T3 Code"),
          whenReady: Effect.void,
          quit: Effect.void,
          exit: () => Effect.void,
          relaunch: () => Effect.void,
          setPath: () => Effect.void,
          setName: () => Effect.void,
          setAboutPanelOptions: () => Effect.void,
          setAppUserModelId: () => Effect.void,
          requestSingleInstanceLock: Effect.succeed(true),
          isDefaultProtocolClient: () => Effect.succeed(false),
          setAsDefaultProtocolClient: (protocol: string) =>
            Effect.sync(() => {
              protocolClientRegistered = protocol === "t3code";
              return true;
            }),
          setDesktopName: () => Effect.void,
          setDockIcon: () => Effect.void,
          appendCommandLineSwitch: () => Effect.void,
          on: <Args extends ReadonlyArray<unknown>>(
            eventName: string,
            listener: (...args: Args) => void,
          ) =>
            Effect.sync(() => {
              listeners.set(eventName, listener as (...args: readonly unknown[]) => void);
            }).pipe(Effect.asVoid),
        } as unknown as ElectronApp.ElectronApp["Service"]);

        const runtimeLayer = Layer.mergeAll(
          makeDesktopClerkLayer(false, true),
          deepLinksLayer,
          electronAppLayer,
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const clerk = yield* DesktopClerk.DesktopClerk;
            yield* clerk.configure;

            assert.isTrue(protocolClientRegistered);
            assert.isTrue(listeners.has("second-instance"));
            assert.isTrue(listeners.has("open-url"));

            // Initial process.argv is captured during configure.
            const initialHandled = yield* Ref.get(handledArgv);
            assert.isTrue(initialHandled.length >= 1);

            const secondInstance = listeners.get("second-instance");
            assert.isDefined(secondInstance);
            secondInstance?.({}, [
              "t3code",
              "t3code://open/thread?connection=t3vm&thread=ebf3a84d-7f60-4809-a5e0-bbd574275463",
            ]);
            // Allow the fire-and-forget runPromise callback to settle.
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;

            const afterSecond = yield* Ref.get(handledArgv);
            assert.isTrue(
              afterSecond.some((argv) =>
                argv.some((entry) => entry.startsWith("t3code://open/thread")),
              ),
            );

            const openUrl = listeners.get("open-url");
            assert.isDefined(openUrl);
            const preventDefault = vi.fn();
            openUrl?.(
              { preventDefault },
              "t3code://open/thread?connection=t3vm&thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            );
            yield* Effect.yieldNow;
            yield* Effect.yieldNow;
            assert.equal(preventDefault.mock.calls.length, 1);
            const urls = yield* Ref.get(handledUrls);
            assert.deepEqual(urls, [
              "t3code://open/thread?connection=t3vm&thread=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
            ]);
          }).pipe(Effect.provide(runtimeLayer)),
        );
      });
    },
  );

  it.effect("does not register the OS protocol client in development", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn() });

    return Effect.gen(function* () {
      let protocolClientRegistered = false;

      const deepLinksLayer = Layer.succeed(DesktopDeepLinks.DesktopDeepLinks, {
        handleArgv: () => Effect.void,
        handleUrl: () => Effect.void,
        start: Effect.void,
      } satisfies DesktopDeepLinks.DesktopDeepLinks["Service"]);

      const electronAppLayer = Layer.succeed(ElectronApp.ElectronApp, {
        requestSingleInstanceLock: Effect.succeed(true),
        setAsDefaultProtocolClient: () =>
          Effect.sync(() => {
            protocolClientRegistered = true;
            return true;
          }),
        on: () => Effect.void,
        quit: Effect.void,
      } as unknown as ElectronApp.ElectronApp["Service"]);

      const runtimeLayer = Layer.mergeAll(
        makeDesktopClerkLayer(true, false),
        deepLinksLayer,
        electronAppLayer,
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const clerk = yield* DesktopClerk.DesktopClerk;
          yield* clerk.configure;
          assert.isFalse(protocolClientRegistered);
        }).pipe(Effect.provide(runtimeLayer)),
      );
    });
  });
});
