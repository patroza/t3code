import type { ConfirmDialogOptions, ContextMenuItem, LocalApi } from "@t3tools/contracts";

import { requestConfirmDialog } from "./confirmDialog";
import { dismissContextMenu, showContextMenuFallback } from "./contextMenuFallback";
import { readBrowserClientSettings, writeBrowserClientSettings } from "./clientPersistenceStorage";

let cachedApi: LocalApi | undefined;

function unavailableLocalBackendError(): Error {
  return new Error("Local backend API is unavailable before a backend is paired.");
}

function rejectUnavailable(): Promise<never> {
  return Promise.reject(unavailableLocalBackendError());
}

function createBrowserLocalApi(): LocalApi {
  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message, options?: ConfirmDialogOptions) => {
        return requestConfirmDialog(message, options) ?? false;
      },
      pickOpenWithApplication: async () => {
        if (!window.desktopBridge) return rejectUnavailable();
        return window.desktopBridge.pickOpenWithApplication();
      },
    },
    shell: {
      openInEditor: async () => rejectUnavailable(),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
      resolveOpenWithPresentations: async () => {
        if (!window.desktopBridge) return rejectUnavailable();
        return window.desktopBridge.resolveOpenWithPresentations();
      },
      openWith: async (input) => {
        if (!window.desktopBridge) return rejectUnavailable();
        return window.desktopBridge.openWith(input);
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
      // A native desktop menu blocks keyboard input and closes on outside
      // interaction, so nothing to do there; the DOM fallback needs an explicit
      // dismiss when the state behind it goes away.
      close: async () => {
        if (!window.desktopBridge) {
          dismissContextMenu();
        }
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
    },
    server: {
      getConfig: () => rejectUnavailable(),
      refreshProviders: () => rejectUnavailable(),
      updateProvider: () => rejectUnavailable(),
      upsertKeybinding: () => rejectUnavailable(),
      removeKeybinding: () => rejectUnavailable(),
      getSettings: () => rejectUnavailable(),
      updateSettings: () => rejectUnavailable(),
      discoverSourceControl: () => rejectUnavailable(),
      getTraceDiagnostics: () => rejectUnavailable(),
      getProcessDiagnostics: () => rejectUnavailable(),
      getProcessResourceHistory: () => rejectUnavailable(),
      signalProcess: () => rejectUnavailable(),
    },
  };
}

export function createLocalApi(): LocalApi {
  return createBrowserLocalApi();
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  const nativeApi = (window as Window & { nativeApi?: LocalApi }).nativeApi;
  if (nativeApi) {
    cachedApi = nativeApi;
    return cachedApi;
  }

  cachedApi = createLocalApi();
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}
