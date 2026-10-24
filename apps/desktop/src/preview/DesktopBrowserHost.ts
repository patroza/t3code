// @effect-diagnostics nodeBuiltinImport:off - Names download files, and loads Electron only to hand focus back after a click.
/**
 * The preview manager owns the tab's single debugger session and hands it here;
 * the relay shares it.
 */
import {
  DesktopBrowserCommand,
  DesktopBrowserEvent,
  type DesktopBrowserEvent as DesktopBrowserEventType,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { createCdpRelayConnection, type CdpRelayConnection } from "./CdpRelay.ts";
import { sendPageCommand } from "./GuestInput.ts";

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(DesktopBrowserEvent));
const decodeCommand = Schema.decodeUnknownOption(Schema.fromJsonString(DesktopBrowserCommand));
const lineEncoder = new TextEncoder();
const requireElectron = NodeModule.createRequire(import.meta.url);

/** The bits of Electron a click needs in order to give focus back. */
interface PreviewFocusSource {
  readonly getFocusedWebContents: () => Electron.WebContents | null;
  readonly getFocusedWindow: () => unknown;
}

/**
 * A preview click focuses the guest page. Hand focus back to whoever had it,
 * unless that was the guest, the user picked something else while the click
 * ran, or they left the app.
 */
export function restorePreviewFocus(input: {
  readonly guestId: number;
  readonly previouslyFocused: Electron.WebContents | null;
  readonly focusedNow: Electron.WebContents | null;
  readonly appWindowFocused: boolean;
}): void {
  const previouslyFocused = input.previouslyFocused;
  if (
    previouslyFocused === null ||
    previouslyFocused.id === input.guestId ||
    previouslyFocused.isDestroyed()
  ) {
    return;
  }
  const focusedNow = input.focusedNow;
  if (
    focusedNow !== null &&
    focusedNow.id !== input.guestId &&
    focusedNow.id !== previouslyFocused.id
  ) {
    return;
  }
  if (focusedNow === null && !input.appWindowFocused) return;
  previouslyFocused.focus();
}

const loadElectronFocus = (): PreviewFocusSource | null => {
  try {
    const electron = requireElectron("electron") as {
      readonly webContents: { getFocusedWebContents: () => Electron.WebContents | null };
      readonly BrowserWindow: { getFocusedWindow: () => unknown };
    };
    return {
      getFocusedWebContents: () => electron.webContents.getFocusedWebContents(),
      getFocusedWindow: () => electron.BrowserWindow.getFocusedWindow(),
    };
  } catch {
    return null;
  }
};

const readFocus = (read: () => Electron.WebContents | null): Electron.WebContents | null => {
  try {
    return read();
  } catch {
    return null;
  }
};

/**
 * Snapshot focus before a mouse press or release, and restore it once that
 * command settles. Playwright sends the two events separately, so each one
 * has to hand focus back or the release leaves the guest focused.
 */
export function sendPreviewDebuggerCommand(
  debuggee: {
    readonly sendCommand: (
      method: string,
      params?: unknown,
      sessionId?: string,
    ) => Promise<unknown>;
  },
  guest: Electron.WebContents,
  method: string,
  params: Record<string, unknown>,
  sessionId: string | undefined,
  focus: PreviewFocusSource | null,
): Promise<unknown> {
  const mouseButton =
    method === "Input.dispatchMouseEvent" &&
    (params.type === "mousePressed" || params.type === "mouseReleased");
  const previouslyFocused =
    mouseButton && focus !== null ? readFocus(() => focus.getFocusedWebContents()) : null;
  const sent =
    sessionId === undefined
      ? debuggee.sendCommand(method, params)
      : debuggee.sendCommand(method, params, sessionId);
  if (!mouseButton || focus === null) return sent;
  return Promise.resolve(sent).finally(() => {
    try {
      const focusedNow = readFocus(() => focus.getFocusedWebContents());
      let appWindowFocused = false;
      try {
        appWindowFocused = focus.getFocusedWindow() !== null;
      } catch {
        appWindowFocused = false;
      }
      restorePreviewFocus({
        guestId: guest.id,
        previouslyFocused,
        focusedNow,
        appWindowFocused,
      });
    } catch {
      // Restoring focus must not fail the click the agent already sent.
    }
  });
}
/** CDP commands through which an agent clicks, types, or navigates the page. */

const AGENT_INPUT_COMMAND =
  /"method":"(?:Input\.|Page\.navigate"|Runtime\.(?:evaluate|callFunctionOn)")/;
const AGENT_DOWNLOAD_WINDOW_MS = 5_000;

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
}

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  screenshotTurn: object | null;
  readonly waitingScreenshots: Array<() => void>;
  downloadDirectory: string | null;
  pendingDownloadGuid: string | null;
  agentInputAt: number;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
  readonly onNewDocument: () => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    readonly events: Stream.Stream<Uint8Array>;
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    readonly detach: (key: DesktopBrowserTabKey) => void;
    readonly humanStartedDownload: (source: Electron.WebContents) => boolean;
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    readonly pointers: Stream.Stream<{
      readonly key: DesktopBrowserTabKey;
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
    }>;
  }
>()("@t3tools/desktop/preview/DesktopBrowserHost") {}

export const make = Effect.gen(function* () {
  const outbox = yield* PubSub.unbounded<DesktopBrowserEventType>();
  const pointers = yield* PubSub.sliding<{
    readonly key: DesktopBrowserTabKey;
    readonly phase: "move" | "click";
    readonly x: number;
    readonly y: number;
  }>(16);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const tabs = new Map<string, AttachedTab>();
  const emit = (event: DesktopBrowserEventType) => runFork(PubSub.publish(outbox, event));

  const nextScreenshot = (tab: AttachedTab) => {
    tab.screenshotTurn = null;
    tab.waitingScreenshots.shift()?.();
  };

  /**
   * Chromium below 157 crashes the whole app when a guest's renderer exits with a
   * screenshot copy in flight (crbug.com/567321049). Overlapping screenshots make that
   * far likelier, and one the server gave up on stays pending in Chromium, so each guest
   * gets one at a time. One queued by a relay released since then is dropped unsent.
   */
  const takeScreenshot = (
    tab: AttachedTab,
    relay: CdpRelayConnection,
    capture: () => Promise<unknown>,
  ) =>
    new Promise<unknown>((resolve, reject) => {
      const start = () => {
        if (tab.relay !== relay) {
          reject(new Error("The preview connection that asked for this screenshot closed."));
          nextScreenshot(tab);
          return;
        }
        const turn = {};
        tab.screenshotTurn = turn;
        capture()
          .finally(() => {
            if (tab.screenshotTurn === turn) nextScreenshot(tab);
          })
          .then(resolve, reject);
      };
      if (tab.screenshotTurn === null) start();
      else tab.waitingScreenshots.push(start);
    });

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const send = (method: string, params: Record<string, unknown>, sessionId?: string) =>
      method === "Input.dispatchMouseEvent" &&
      (params.type === "mousePressed" || params.type === "mouseReleased")
        ? sendPreviewDebuggerCommand(
            debuggee,
            webContents,
            method,
            params,
            sessionId,
            loadElectronFocus(),
          )
        : sessionId === undefined
          ? sendPageCommand(webContents, debuggee, method, params)
          : debuggee.sendCommand(method, params, sessionId);
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId) =>
          method === "Page.captureScreenshot"
            ? takeScreenshot(tab, relay, () => send(method, params, sessionId))
            : send(method, params, sessionId),
        targetId: () =>
          debuggee
            .sendCommand("Target.getTargetInfo")
            .then((result: { targetInfo: { targetId: string } }) => result.targetInfo.targetId),
        url: () => webContents.getURL(),
        title: () => webContents.getTitle(),
        userAgent: () => webContents.getUserAgent(),
        setDownloadDirectory: (directory) => {
          tab.downloadDirectory = directory;
        },
      },
      (message) => {
        if (tab.relay === relay && tabs.get(keyOf(tab.key)) === tab) {
          emit({ type: "cdp", ...tab.key, message });
        }
      },
    );
    tab.relay = relay;
    return relay;
  };

  /**
   * Without a path Electron would open its Save dialog over the app for a file
   * the agent asked for. CDP names the download just before this runs.
   */
  const placeDownload = (source: Electron.WebContents, item: Electron.DownloadItem) => {
    const tab = [...tabs.values()].find(
      (candidate) => candidate.debuggee.webContents === source && candidate.downloadDirectory,
    );
    if (!tab?.downloadDirectory || !tab.pendingDownloadGuid) return false;
    item.setSavePath(NodePath.join(tab.downloadDirectory, tab.pendingDownloadGuid));
    tab.pendingDownloadGuid = null;
    return true;
  };

  const detach = (key: DesktopBrowserTabKey) => {
    const id = keyOf(key);
    const tab = tabs.get(id);
    if (!tab) return;
    tabs.delete(id);
    tab.relay = null;
    tab.debuggee.debugger.off("message", tab.onMessage);
    tab.debuggee.webContents.off("did-navigate", tab.onNewDocument);
    emit({ type: "detached", ...key });
  };

  const attach = (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => {
    const id = keyOf(key);
    if (tabs.get(id)?.debuggee.webContents === debuggee.webContents) return;
    detach(key);
    const tab: AttachedTab = {
      key,
      debuggee,
      relay: null,
      screenshotTurn: null,
      waitingScreenshots: [],
      downloadDirectory: null,
      pendingDownloadGuid: null,
      agentInputAt: Number.NEGATIVE_INFINITY,
      onMessage: (_event, method, params, sessionId) => {
        if (method === "Browser.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
      // A screenshot pending when the page loads a new document, a reload included, can
      // stay unanswered. A crashed page lands here once it reloads, well after its renderer died.
      onNewDocument: () => {
        if (tab.screenshotTurn !== null) nextScreenshot(tab);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
    debuggee.webContents.on("did-navigate", tab.onNewDocument);
    emit({ type: "attached", ...key });
  };

  const handleCommandLine = (line: string) =>
    Effect.sync(() => {
      const command = decodeCommand(line);
      if (Option.isNone(command)) return;
      const tab = tabs.get(keyOf(command.value));
      if (!tab) return;
      if (command.value.type === "pointer") {
        const { threadId, tabId, phase, x, y } = command.value;
        runFork(PubSub.publish(pointers, { key: { threadId, tabId }, phase, x, y }));
        return;
      }
      if (command.value.type === "release") {
        tab.relay = null;
        return;
      }
      if (AGENT_INPUT_COMMAND.test(command.value.message)) tab.agentInputAt = performance.now();
      relayFor(tab).receive(command.value.message);
    });

  const humanStartedDownload = (source: Electron.WebContents) => {
    const tab = [...tabs.values()].find((candidate) => candidate.debuggee.webContents === source);
    return tab !== undefined && performance.now() - tab.agentInputAt > AGENT_DOWNLOAD_WINDOW_MS;
  };

  const announceAll = Effect.suspend(() =>
    Effect.forEach(
      [...tabs.values()],
      (tab) => {
        tab.relay = null;
        return PubSub.publish(outbox, { type: "attached", ...tab.key });
      },
      { discard: true },
    ),
  );

  return DesktopBrowserHost.of({
    pointers: Stream.fromPubSub(pointers),
    // Subscribes before announcing, so no attach falls between the two.
    events: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(outbox);
        yield* announceAll;
        return Stream.fromSubscription(subscription);
      }),
    ).pipe(Stream.map((event) => lineEncoder.encode(`${encodeEvent(event)}\n`))),
    handleCommandLine,
    attach,
    detach,
    placeDownload,
    humanStartedDownload,
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
