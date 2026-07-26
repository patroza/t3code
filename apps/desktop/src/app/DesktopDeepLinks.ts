import {
  ConnectionCatalogDocument,
  type ConnectionCatalogDocument as ConnectionCatalogDocumentType,
} from "@t3tools/client-runtime/platform";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { buildDesktopThreadNavigationUrl } from "../electron/ElectronProtocol.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as DesktopConnectionCatalogStore from "./DesktopConnectionCatalogStore.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

export { buildDesktopThreadNavigationUrl };

export const DESKTOP_EXTERNAL_PROTOCOL = "t3code";
export const DESKTOP_THREAD_DEEP_LINK_HOST = "open";
export const DESKTOP_THREAD_DEEP_LINK_PATH = "/thread";
export const DESKTOP_PROJECT_DEEP_LINK_PATH = "/project";

/** Reject oversized query values (connection labels and thread ids). */
const MAX_DEEP_LINK_VALUE_LENGTH = 256;

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export type DesktopThreadDeepLink = {
  readonly connectionLabel: string;
  readonly threadId: ThreadId;
};

export type DesktopProjectDeepLink = {
  readonly project: string;
  readonly action: "reveal" | "latest" | "new";
};

export type DesktopConnectionLabelResolution =
  | { readonly _tag: "resolved"; readonly environmentId: EnvironmentId }
  | { readonly _tag: "missing" }
  | { readonly _tag: "ambiguous" }
  | { readonly _tag: "invalidCatalog"; readonly cause: unknown };

type PendingDeepLinkAction =
  | { readonly _tag: "reveal" }
  | { readonly _tag: "openThread"; readonly deepLink: DesktopThreadDeepLink }
  | { readonly _tag: "openProject"; readonly deepLink: DesktopProjectDeepLink };

const { logInfo: logDeepLinkInfo, logWarning: logDeepLinkWarning } =
  makeComponentLogger("desktop-deep-links");

/**
 * Parses a desktop thread deep link in either explicit or host shorthand form:
 *
 * - `t3code://open/thread?connection=<environment>&thread=<thread-id>`
 * - `t3code://<environment>?thread=<thread-id>`
 */
export function parseDesktopThreadDeepLink(raw: string): Option.Option<DesktopThreadDeepLink> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) {
    return Option.none();
  }
  if (CONTROL_CHARACTER_PATTERN.test(raw)) {
    return Option.none();
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return Option.none();
  }

  if (url.protocol !== `${DESKTOP_EXTERNAL_PROTOCOL}:`) {
    return Option.none();
  }
  // Normalize trailing slashes so `/thread` and `/thread/` both work.
  const pathname =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;

  const connectionValues = url.searchParams.getAll("connection");
  const threadValues = url.searchParams.getAll("thread");
  if (threadValues.length !== 1) {
    return Option.none();
  }

  const isExplicitForm =
    url.hostname === DESKTOP_THREAD_DEEP_LINK_HOST && pathname === DESKTOP_THREAD_DEEP_LINK_PATH;
  const isHostShorthand = (pathname === "" || pathname === "/") && url.hostname.length > 0;
  if (
    (!isExplicitForm && !isHostShorthand) ||
    (isExplicitForm && connectionValues.length !== 1) ||
    (isHostShorthand && connectionValues.length !== 0)
  ) {
    return Option.none();
  }

  // URLSearchParams percent-decodes once; reject empties, controls, and oversized values.
  const connectionLabel = isExplicitForm ? (connectionValues[0] ?? "") : url.hostname;
  const threadRaw = threadValues[0] ?? "";
  if (
    connectionLabel.length === 0 ||
    threadRaw.length === 0 ||
    connectionLabel.length > MAX_DEEP_LINK_VALUE_LENGTH ||
    threadRaw.length > MAX_DEEP_LINK_VALUE_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(connectionLabel) ||
    CONTROL_CHARACTER_PATTERN.test(threadRaw)
  ) {
    return Option.none();
  }

  let threadId: ThreadId;
  try {
    threadId = Schema.decodeUnknownSync(ThreadId)(threadRaw);
  } catch {
    return Option.none();
  }

  return Option.some({
    connectionLabel,
    threadId,
  });
}

export function parseDesktopProjectDeepLink(raw: string): Option.Option<DesktopProjectDeepLink> {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 2_048) {
    return Option.none();
  }
  if (CONTROL_CHARACTER_PATTERN.test(raw)) {
    return Option.none();
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return Option.none();
  }

  const pathname =
    url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
  if (
    url.protocol !== `${DESKTOP_EXTERNAL_PROTOCOL}:` ||
    url.hostname !== DESKTOP_THREAD_DEEP_LINK_HOST ||
    pathname !== DESKTOP_PROJECT_DEEP_LINK_PATH
  ) {
    return Option.none();
  }

  const projectValues = url.searchParams.getAll("project");
  const actionValues = url.searchParams.getAll("action");
  const project = projectValues[0]?.trim() ?? "";
  if (
    projectValues.length !== 1 ||
    actionValues.length > 1 ||
    project.length === 0 ||
    project.length > MAX_DEEP_LINK_VALUE_LENGTH ||
    CONTROL_CHARACTER_PATTERN.test(project)
  ) {
    return Option.none();
  }

  const action = actionValues[0] ?? "reveal";
  if (action !== "reveal" && action !== "latest" && action !== "new") {
    return Option.none();
  }
  return Option.some({ project, action });
}

/**
 * Scans argv for the first valid thread deep link. Electron may inject
 * platform-specific flags, so the URL is not assumed to be at a fixed index.
 */
export function findDesktopThreadDeepLinkInArgv(
  argv: readonly string[],
): Option.Option<DesktopThreadDeepLink> {
  for (const entry of argv) {
    const parsed = parseDesktopThreadDeepLink(entry);
    if (Option.isSome(parsed)) {
      return parsed;
    }
  }
  return Option.none();
}

function isShortAndFqdnMatch(left: string, right: string): boolean {
  const leftIsFqdn = left.includes(".");
  const rightIsFqdn = right.includes(".");
  if (leftIsFqdn === rightIsFqdn) {
    return false;
  }
  const shortLabel = leftIsFqdn ? right : left;
  const fqdnLabel = leftIsFqdn ? left : right;
  return fqdnLabel.slice(0, fqdnLabel.indexOf(".")) === shortLabel;
}

/**
 * Resolves a configured deep-link connection label to a unique environment id.
 *
 * The link producer's configured override is already represented by
 * `connectionLabel`. Exact catalog labels win; only a missing exact match may
 * fall back to matching a short host label with its FQDN form.
 */
export function resolveEnvironmentIdForConnectionLabel(
  catalogJson: string,
  connectionLabel: string,
): DesktopConnectionLabelResolution {
  let document: ConnectionCatalogDocumentType;
  try {
    document = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument))(
      catalogJson,
    );
  } catch (cause) {
    return { _tag: "invalidCatalog", cause };
  }

  const exactMatches = document.targets.filter((target) => target.label === connectionLabel);
  const matches =
    exactMatches.length > 0
      ? exactMatches
      : document.targets.filter((target) => isShortAndFqdnMatch(target.label, connectionLabel));
  if (matches.length === 0) {
    return { _tag: "missing" };
  }
  if (matches.length > 1) {
    return { _tag: "ambiguous" };
  }
  return {
    _tag: "resolved",
    environmentId: matches[0]!.environmentId,
  };
}

export class DesktopDeepLinks extends Context.Service<
  DesktopDeepLinks,
  {
    /**
     * Handle a launch argv (initial process.argv or second-instance commandLine).
     * Queues until `start` if the navigation services are not ready yet.
     */
    readonly handleArgv: (argv: readonly string[]) => Effect.Effect<void>;
    /**
     * Handle a macOS `open-url` deep link.
     */
    readonly handleUrl: (url: string) => Effect.Effect<void>;
    /**
     * Begin processing deep links. Flushes any action queued before readiness.
     * Newest queued action wins.
     */
    readonly start: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopDeepLinks") {}

export const make = Effect.gen(function* () {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const catalogStore = yield* DesktopConnectionCatalogStore.DesktopConnectionCatalogStore;
  const startedRef = yield* Ref.make(false);
  const pendingActionRef = yield* Ref.make<Option.Option<PendingDeepLinkAction>>(Option.none());

  const revealOnly = desktopWindow.activate.pipe(
    Effect.catch((error) =>
      logDeepLinkWarning("failed to reveal desktop window for deep link", {
        message: error.message,
      }),
    ),
    Effect.asVoid,
  );

  const resolveDeepLinkFromCatalog = (
    deepLink: DesktopThreadDeepLink,
  ): Effect.Effect<DesktopConnectionLabelResolution> =>
    catalogStore.get.pipe(
      Effect.catch((cause) =>
        logDeepLinkWarning("connection catalog unavailable for deep link resolution", {
          reason: cause._tag,
        }).pipe(Effect.as(Option.none<string>())),
      ),
      Effect.map((catalog) => {
        if (Option.isNone(catalog)) {
          return { _tag: "missing" } as const;
        }
        return resolveEnvironmentIdForConnectionLabel(catalog.value, deepLink.connectionLabel);
      }),
    );

  const openResolvedThread = (deepLink: DesktopThreadDeepLink): Effect.Effect<void> =>
    Effect.gen(function* () {
      const resolution = yield* resolveDeepLinkFromCatalog(deepLink);
      switch (resolution._tag) {
        case "resolved": {
          yield* logDeepLinkInfo("opening thread from deep link", {
            connectionLabel: deepLink.connectionLabel,
            // Log only that an environment was resolved — never catalog contents.
            resolved: true,
          });
          yield* desktopWindow
            .navigateToThread({
              environmentId: resolution.environmentId,
              threadId: deepLink.threadId,
            })
            .pipe(
              Effect.catch((error) =>
                logDeepLinkWarning("failed to navigate to deep-linked thread", {
                  message: error.message,
                }),
              ),
            );
          return;
        }
        case "missing": {
          yield* logDeepLinkWarning("deep link connection label not found", {
            connectionLabel: deepLink.connectionLabel,
          });
          yield* revealOnly;
          return;
        }
        case "ambiguous": {
          yield* logDeepLinkWarning("deep link connection label is ambiguous", {
            connectionLabel: deepLink.connectionLabel,
          });
          yield* revealOnly;
          return;
        }
        case "invalidCatalog": {
          yield* logDeepLinkWarning("deep link connection catalog could not be decoded", {
            reason: "invalidCatalog",
          });
          yield* revealOnly;
          return;
        }
      }
    }).pipe(Effect.withSpan("desktop.deepLinks.openResolvedThread"));

  const processAction = (action: PendingDeepLinkAction): Effect.Effect<void> =>
    Effect.gen(function* () {
      switch (action._tag) {
        case "reveal":
          yield* revealOnly;
          return;
        case "openThread":
          yield* openResolvedThread(action.deepLink);
          return;
        case "openProject":
          yield* desktopWindow.navigateToProject(action.deepLink).pipe(
            Effect.catch((error) =>
              logDeepLinkWarning("failed to navigate to deep-linked project", {
                message: error.message,
              }),
            ),
          );
          return;
      }
    }).pipe(Effect.withSpan("desktop.deepLinks.processAction"));

  const enqueueOrProcess = (action: PendingDeepLinkAction): Effect.Effect<void> =>
    Effect.gen(function* () {
      const started = yield* Ref.get(startedRef);
      if (!started) {
        // Newest action wins while startup is still settling.
        yield* Ref.set(pendingActionRef, Option.some(action));
        return;
      }
      yield* processAction(action);
    });

  const handleArgv = (argv: readonly string[]): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const entry of argv) {
        const projectDeepLink = parseDesktopProjectDeepLink(entry);
        if (Option.isSome(projectDeepLink)) {
          yield* enqueueOrProcess({ _tag: "openProject", deepLink: projectDeepLink.value });
          return;
        }
      }
      const deepLink = findDesktopThreadDeepLinkInArgv(argv);
      if (Option.isSome(deepLink)) {
        yield* enqueueOrProcess({ _tag: "openThread", deepLink: deepLink.value });
        return;
      }
      yield* enqueueOrProcess({ _tag: "reveal" });
    }).pipe(Effect.withSpan("desktop.deepLinks.handleArgv"));

  const handleUrl = (url: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const projectDeepLink = parseDesktopProjectDeepLink(url);
      if (Option.isSome(projectDeepLink)) {
        yield* enqueueOrProcess({ _tag: "openProject", deepLink: projectDeepLink.value });
        return;
      }
      const deepLink = parseDesktopThreadDeepLink(url);
      if (Option.isSome(deepLink)) {
        yield* enqueueOrProcess({ _tag: "openThread", deepLink: deepLink.value });
        return;
      }
      yield* logDeepLinkWarning("ignored unsupported open-url payload");
      yield* enqueueOrProcess({ _tag: "reveal" });
    }).pipe(Effect.withSpan("desktop.deepLinks.handleUrl"));

  const start = Effect.gen(function* () {
    const alreadyStarted = yield* Ref.getAndSet(startedRef, true);
    if (alreadyStarted) {
      return;
    }
    const pending = yield* Ref.getAndSet(pendingActionRef, Option.none());
    if (Option.isSome(pending)) {
      yield* processAction(pending.value);
    }
  }).pipe(Effect.withSpan("desktop.deepLinks.start"));

  return DesktopDeepLinks.of({
    handleArgv,
    handleUrl,
    start,
  });
});

export const layer = Layer.effect(DesktopDeepLinks, make);
