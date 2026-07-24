import { createClerkBridge } from "@clerk/electron";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as DesktopDeepLinks from "./DesktopDeepLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedErrorClass<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedErrorClass<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      DesktopDeepLinks.DesktopDeepLinks | ElectronApp.ElectronApp | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

export function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = resolveDesktopClerkFrontendApiHostname(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);

export function createDesktopClerkBridge(stateDir: string, isDevelopment: boolean) {
  return createClerkBridge({
    storage: storage({ path: stateDir }),
    passkeys: true,
    renderer: {
      scheme: ElectronProtocol.getDesktopScheme(isDevelopment),
      host: ElectronProtocol.DESKTOP_HOST,
    },
  });
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => createDesktopClerkBridge(environment.stateDir, environment.isDevelopment),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );

  return DesktopClerk.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const deepLinks = yield* DesktopDeepLinks.DesktopDeepLinks;
      // Capture ambient services for Electron event callbacks, which cannot yield.
      const context = yield* Effect.context<never>();
      const runPromise = Effect.runPromiseWith(context);

      if (!(yield* electronApp.requestSingleInstanceLock)) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      // Register before readiness so cold-start and second-instance deep links
      // are not dropped. Deep-link processing itself queues until start().
      yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[] = []) => {
        void runPromise(deepLinks.handleArgv(argv));
      });

      // macOS delivers custom URL scheme activations through open-url.
      yield* electronApp.on("open-url", (event: { preventDefault?: () => void }, url: string) => {
        event.preventDefault?.();
        void runPromise(deepLinks.handleUrl(url));
      });

      // Packaged builds own the OS protocol handler. Skip in development so a
      // local electron binary does not replace the installed t3code handler.
      if (environment.isPackaged && !environment.isDevelopment) {
        yield* electronApp.setAsDefaultProtocolClient(DesktopDeepLinks.DESKTOP_EXTERNAL_PROTOCOL);
      }

      // Initial argv may already contain a deep link (direct CLI invocation or
      // protocol launch on Linux/Windows).
      yield* deepLinks.handleArgv(process.argv);
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
