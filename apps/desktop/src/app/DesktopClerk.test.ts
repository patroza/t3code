// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Hosted handoff test uses a real localhost listener without an OpenAI account.
import * as NodeHttp from "node:http";
import * as NodePath from "@effect/platform-node/NodePath";
import { codexAuthHandoffUrl, readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopDeepLinks from "./DesktopDeepLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";

const defaultShell: ElectronShell.ElectronShell["Service"] = {
  openExternal: () => Effect.succeed(true),
  openSystemSettings: () => Effect.succeed(false),
  copyText: () => Effect.void,
};

const ignoreWebLinks = DesktopWebLinks.DesktopWebLinks.of({
  receive: () => Effect.void,
  setRendererReady: () => Effect.void,
});

const noopDeepLinks = {
  handleArgv: () => Effect.void,
  handleUrl: () => Effect.void,
  start: Effect.void,
} satisfies DesktopDeepLinks.DesktopDeepLinks["Service"];

const noopElectronWindow = {
  currentMainOrFirst: Effect.succeed(Option.none()),
  reveal: () => Effect.void,
} as unknown as ElectronWindow.ElectronWindow["Service"];

const makeDesktopClerkLayer = (
  isDevelopment = true,
  isPackaged = false,
  events: string[] = [],
  shell: ElectronShell.ElectronShell["Service"] = defaultShell,
  platform: NodeJS.Platform = "darwin",
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({
    exists: () => Effect.succeed(false),
  }),
) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: "/tmp/t3-state",
    isDevelopment,
    isPackaged,
    platform,
    appDataDirectory: "/tmp/app-data",
    userDataDirName: isDevelopment ? "t3code-dev" : platform === "win32" ? "t3code-v2" : "t3code",
    legacyUserDataDirName: isDevelopment ? "T3 Code (Dev)" : "T3 Code (Alpha)",
    path: { join: (...parts: ReadonlyArray<string>) => parts.join("/") },
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePath.layer,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(ElectronShell.ElectronShell, shell),
        fileSystemLayer,
      ),
    ),
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
    const events: string[] = [];
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementation(() => {
      events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(makeDesktopClerkLayer(true, false, events)));

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
      // The bridge acquires Electron's single-instance lock at creation, and
      // the lock both lives in and creates the userData directory — so the
      // real path must be set before the bridge exists.
      assert.deepEqual(events, ["setPath:userData:/tmp/app-data/t3code-dev", "createClerkBridge"]);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it.each([
    {
      name: "packaged Windows",
      isDevelopment: false,
      platform: "win32" as const,
      userData: "/tmp/app-data/t3code-v2",
    },
    {
      name: "development",
      isDevelopment: true,
      platform: "win32" as const,
      userData: "/tmp/app-data/t3code-dev",
    },
  ])(
    "creates the bridge before startup can yield to the event loop ($name)",
    ({ isDevelopment, platform, userData }) => {
      const events: string[] = [];
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockImplementation(() => {
        events.push("createClerkBridge");
        return { cleanup: vi.fn(), isPrimaryInstance: true };
      });
      // runSync throws if the layer ever suspends, which would let Electron emit
      // ready before the bridge exists. main.ts provides the same FileSystem.
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The assertion IS that the layer builds synchronously; it.effect would mask a regression to async.
      Effect.runSync(
        Effect.scoped(
          Layer.build(
            makeDesktopClerkLayer(
              isDevelopment,
              !isDevelopment,
              events,
              defaultShell,
              platform,
              DesktopPreReadyFileSystem.layer,
            ),
          ),
        ),
      );

      assert.deepEqual(events, [`setPath:userData:${userData}`, "createClerkBridge"]);
    },
  );

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
      isPrimaryInstance: true,
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

  it.effect.each([
    { isDevelopment: true, scheme: "t3code-dev" },
    { isDevelopment: false, scheme: "t3code" },
  ] as const)(
    "configures the SDK with the $scheme renderer origin",
    ({ isDevelopment, scheme }) => {
      const bridge = { cleanup: vi.fn(), isPrimaryInstance: true };
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue(bridge);

      return Effect.gen(function* () {
        yield* Effect.scoped(Layer.build(makeDesktopClerkLayer(isDevelopment)));
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
    },
  );

  it.effect("registers the second-instance handler in the primary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
      setAsDefaultProtocolClient: () => Effect.succeed(true),
    } as unknown as ElectronApp.ElectronApp["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["open-file", "open-url", "second-instance"]);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(DesktopDeepLinks.DesktopDeepLinks, noopDeepLinks),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, noopElectronWindow),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: false });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer()),
      Effect.provideService(DesktopDeepLinks.DesktopDeepLinks, noopDeepLinks),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, noopElectronWindow),
    );
  });

  it.effect(
    "wires second-instance argv into deep links and registers the protocol when packaged",
    () => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });

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
          Layer.succeed(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
          electronAppLayer,
          Layer.succeed(ElectronWindow.ElectronWindow, noopElectronWindow),
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
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });

    return Effect.gen(function* () {
      let protocolClientRegistered = false;

      const deepLinksLayer = Layer.succeed(DesktopDeepLinks.DesktopDeepLinks, noopDeepLinks);

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
        Layer.succeed(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
        electronAppLayer,
        Layer.succeed(ElectronWindow.ElectronWindow, noopElectronWindow),
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

  it.effect(
    "provider auth deep links navigate and reveal the running desktop without handling Clerk URLs",
    () => {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const revealed = Promise.withResolvers<void>();
      const loadURL = vi.fn(async (_url: string) => undefined);
      const window = { loadURL };
      const electronApp = {
        on: (name: string, listener: (...args: unknown[]) => void) =>
          Effect.sync(() => {
            listeners.set(name, listener);
          }),
        setAsDefaultProtocolClient: () => Effect.succeed(true),
      } as unknown as ElectronApp.ElectronApp["Service"];
      const electronWindow = {
        currentMainOrFirst: Effect.succeed(Option.some(window)),
        reveal: () => Effect.sync(() => revealed.resolve()),
      } as unknown as ElectronWindow.ElectronWindow["Service"];
      return Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;
        const event = { preventDefault: vi.fn() };
        listeners.get("open-url")!(event, "t3code-dev://app/auth/callback?code=clerk-code");
        listeners.get("open-url")!(event, "t3code://app/welcome");
        assert.equal(loadURL.mock.calls.length, 0);
        assert.equal(event.preventDefault.mock.calls.length, 0);
        listeners.get("second-instance")!({}, [
          "t3",
          "t3code-dev://app/settings/providers?instanceId=work&code=never-forward",
        ]);
        yield* Effect.promise(() => revealed.promise);
        assert.deepEqual(loadURL.mock.calls, [
          ["t3code-dev://app/settings/providers?instanceId=work"],
        ]);
        listeners.get("open-url")!(event, "t3code-dev://app/welcome#agents:machine-id");
        assert.equal(event.preventDefault.mock.calls.length, 1);
      }).pipe(
        Effect.scoped,
        Effect.provide(makeDesktopClerkLayer()),
        Effect.provideService(DesktopDeepLinks.DesktopDeepLinks, noopDeepLinks),
        Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      );
    },
  );

  it.effect.each(["startup", "open-url"] as const)(
    "receives hosted web sign-in through the desktop %s handler",
    (entry) =>
      Effect.gen(function* () {
        storageMock.mockReturnValue(storageAdapter);
        createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
        const port = yield* Effect.promise(async () => {
          const server = NodeHttp.createServer();
          await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("address");
          await new Promise<void>((resolve) => server.close(() => resolve()));
          return address.port;
        });
        const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
        authorize.search = new URLSearchParams({
          client_id: "dynamic_agent_client",
          response_type: "code",
          redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
          state: "a".repeat(43),
          code_challenge_method: "S256",
          code_challenge: "b".repeat(43),
        }).toString();
        const request = {
          authorizationUrl: authorize.toString(),
          returnUrl: "https://app.t3.codes/welcome#agents:remote-one",
          environmentId: EnvironmentId.make("remote-one"),
          instanceId: ProviderInstanceId.make("work"),
          flowId: "flow-one",
        };
        const link = codexAuthHandoffUrl(request, true);
        const delivered = Promise.withResolvers<string>();
        const shell = ElectronShell.ElectronShell.of({
          openExternal: (value) =>
            Effect.promise(async () => {
              const url = new URL(String(value));
              const callback = new URL(url.searchParams.get("redirect_uri")!);
              callback.search = new URLSearchParams({
                state: url.searchParams.get("state")!,
                code: "test-code",
                client_id: "oaiapp_test",
              }).toString();
              const response = await fetch(callback, { redirect: "manual" });
              delivered.resolve(response.headers.get("location")!);
              return true;
            }),
          openSystemSettings: () => Effect.succeed(false),
          copyText: () => Effect.void,
        });
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const electronApp = {
          whenReady: Effect.void,
          on: (name: string, listener: (...args: unknown[]) => void) =>
            Effect.sync(() => {
              listeners.set(name, listener);
            }),
          setAsDefaultProtocolClient: () => Effect.succeed(true),
        } as unknown as ElectronApp.ElectronApp["Service"];
        yield* Effect.gen(function* () {
          const clerk = yield* DesktopClerk.DesktopClerk;
          yield* clerk.configure;
          if (entry === "open-url") {
            const event = { preventDefault: vi.fn() };
            listeners.get("open-url")!(event, link);
            assert.strictEqual(event.preventDefault.mock.calls.length, 1);
          }
          const delivery = readCodexAuthDelivery(yield* Effect.promise(() => delivered.promise));
          assert.strictEqual(delivery?.environmentId, request.environmentId);
          assert.strictEqual(delivery?.instanceId, request.instanceId);
          assert.strictEqual(delivery?.flowId, request.flowId);
          assert.strictEqual(delivery?.returnUrl, request.returnUrl);
        }).pipe(
          Effect.provide(makeDesktopClerkLayer(true, false, [], shell)),
          Effect.provideService(HostProcess.Arguments, entry === "startup" ? ["t3", link] : ["t3"]),
          Effect.provideService(DesktopDeepLinks.DesktopDeepLinks, noopDeepLinks),
          Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
          Effect.provideService(ElectronApp.ElectronApp, electronApp),
          Effect.provideService(ElectronWindow.ElectronWindow, noopElectronWindow),
        );
      }).pipe(Effect.scoped),
  );
});

it.effect("hands a web link to the renderer and leaves other links alone", () =>
  Effect.gen(function* () {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const electronApp = {
      whenReady: Effect.void,
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const received: Array<string> = [];
    yield* Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const open = (url: string) => {
        const event = { preventDefault: vi.fn() };
        listeners.get("open-url")!(event, url);
        return event.preventDefault.mock.calls.length;
      };
      // macOS hands the default browser every web link.
      assert.strictEqual(open("https://example.com/page"), 1);
      assert.strictEqual(open("http://localhost:3000/"), 1);
      // Anything else is not a web page; Electron keeps its own handling.
      assert.strictEqual(open("mailto:hello@example.com"), 0);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(received, ["https://example.com/page", "http://localhost:3000/"]);
    }).pipe(
      Effect.provide(makeDesktopClerkLayer(true, false, [], defaultShell, "darwin")),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(DesktopDeepLinks.DesktopDeepLinks, noopDeepLinks),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) => Effect.sync(() => void received.push(url)),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);
