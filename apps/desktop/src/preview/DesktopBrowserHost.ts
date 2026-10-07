// @effect-diagnostics nodeBuiltinImport:off - Names download files, and loads Electron only to hand focus back after a click.
/**
 * The desktop end of the desktop browser channel (see `DesktopBrowserEvent` in
 * contracts). The primary backend gets two file descriptors at spawn: this
 * service writes events for the desktop's tabs to one and reads commands from
 * the other. Each attached tab is reachable only through its `CdpRelay`.
 *
 * A tab is attached once its `<webview>` registers with a key the web app
 * gave it. The preview manager owns the tab's single debugger session and hands
 * it here; the relay shares it.
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

export interface DesktopBrowserTabKey {
  readonly threadId: string;
  readonly tabId: string;
}

/** A tab's debugger, as the preview manager lends it to the relay. */
export interface DesktopBrowserTabDebugger {
  readonly webContents: Electron.WebContents;
  readonly debugger: Electron.Debugger;
}

const keyOf = ({ threadId, tabId }: DesktopBrowserTabKey) => `${threadId}\u0000${tabId}`;

interface AttachedTab {
  readonly key: DesktopBrowserTabKey;
  readonly debuggee: DesktopBrowserTabDebugger;
  relay: CdpRelayConnection | null;
  /** Where the server wants this tab's downloads; null keeps Electron's own handling. */
  downloadDirectory: string | null;
  /** The guid CDP gave the download that is about to start. */
  pendingDownloadGuid: string | null;
  readonly onMessage: (
    event: Electron.Event,
    method: string,
    params: unknown,
    sessionId: string,
  ) => void;
}

export class DesktopBrowserHost extends Context.Service<
  DesktopBrowserHost,
  {
    /**
     * Newline-delimited events for a backend's browser fd. Each run starts by
     * announcing the tabs already attached, so a restarted backend hears them.
     */
    readonly events: Stream.Stream<Uint8Array>;
    /** One line from the backend's browser control fd. */
    readonly handleCommandLine: (line: string) => Effect.Effect<void>;
    /** Offers a server tab's `<webview>` to the server. */
    readonly attach: (key: DesktopBrowserTabKey, debuggee: DesktopBrowserTabDebugger) => void;
    /** Withdraws it: closed, swapped, crashed, or devtools needs the debugger. */
    readonly detach: (key: DesktopBrowserTabKey) => void;
    /** Points a server tab's download at the server; false for any other download. */
    readonly placeDownload: (source: Electron.WebContents, item: Electron.DownloadItem) => boolean;
    /** The agent's cursor positions for attached tabs, keyed by their server tab. */
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

  const relayFor = (tab: AttachedTab) => {
    if (tab.relay) return tab.relay;
    const { webContents, debugger: debuggee } = tab.debuggee;
    const relay: CdpRelayConnection = createCdpRelayConnection(
      {
        send: (method, params, sessionId) =>
          sendPreviewDebuggerCommand(
            debuggee,
            webContents,
            method,
            params,
            sessionId,
            method === "Input.dispatchMouseEvent" &&
              (params.type === "mousePressed" || params.type === "mouseReleased")
              ? loadElectronFocus()
              : null,
          ),
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
      // A released relay's late replies belong to a connection that is gone.
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
   * Saves a download from a server tab where the server's Playwright expects
   * it. Without a path Electron would open its Save dialog over the app for a
   * file the agent asked for. CDP names the download just before this runs.
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
    tab.debuggee.debugger.off("message", tab.onMessage);
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
      downloadDirectory: null,
      pendingDownloadGuid: null,
      onMessage: (_event, method, params, sessionId) => {
        if (method === "Browser.downloadWillBegin") {
          const guid = (params as { guid?: unknown } | undefined)?.guid;
          tab.pendingDownloadGuid = typeof guid === "string" ? guid : null;
        }
        tab.relay?.event(method, params, sessionId);
      },
    };
    tabs.set(id, tab);
    debuggee.debugger.on("message", tab.onMessage);
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
        // A new server connection starts with a fresh relay and fresh sessions.
        tab.relay = null;
        return;
      }
      relayFor(tab).receive(command.value.message);
    });

  // Read when a backend starts, not when the host is built.
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
  });
});

export const layer = Layer.effect(DesktopBrowserHost, make);
