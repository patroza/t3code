import {
  REMOTE_CAPABLE_EDITOR_IDS,
  remoteSchemeForEditor,
  type SystemSettingsPane,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

/**
 * Deep links to individual System Settings panes. These are app-fixed, not
 * renderer-supplied, so they skip `parseSafeExternalUrl` — which exists to keep
 * arbitrary link schemes from reaching the OS handler — and open through their
 * own path below. The pane rather than the URL crosses the IPC boundary, so a
 * renderer can only ask for one of these known destinations.
 *
 * Full Disk Access uses the post-Ventura `PrivacySecurity.extension` anchor.
 */
const SYSTEM_SETTINGS_URLS: Record<SystemSettingsPane, string> = {
  "full-disk-access":
    "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles",
};

const SAFE_WEB_PROTOCOLS = new Set(["http:", "https:"]);
// Editor URL schemes whose handler runs in the user's graphical session, so the desktop can open a
// file/folder or a Remote-SSH target even when the t3 server runs headless (e.g. a lingered systemd
// user service with no display env).
//
// Upstream (#6572) added these schemes to SAFE_EXTERNAL_PROTOCOLS instead, which allows any URL
// carrying one. They stay here so the hostname/path check below still applies — that check already
// permits upstream's `<scheme>://vscode-remote/ssh-remote+…` deep links. The remote-capable schemes
// are derived rather than listed, so an editor added upstream is covered without another edit.
const SAFE_EDITOR_PROTOCOLS = new Set([
  "vscode:",
  "vscode-insiders:",
  "cursor:",
  ...REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
]);
const REMOTE_EDITOR_PROTOCOLS = new Set(
  REMOTE_CAPABLE_EDITOR_IDS.flatMap((id) => {
    const scheme = remoteSchemeForEditor(id);
    return scheme === undefined ? [] : [`${scheme}:`];
  }),
);

const isRemoteEditorUrl = (url: URL) =>
  REMOTE_EDITOR_PROTOCOLS.has(url.protocol) &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.host === "vscode-remote" &&
  url.pathname.startsWith("/ssh-remote+") &&
  url.pathname.length > "/ssh-remote+".length;

const isLocalEditorFileUrl = (url: URL) =>
  SAFE_EDITOR_PROTOCOLS.has(url.protocol) &&
  url.username.length === 0 &&
  url.password.length === 0 &&
  url.hostname === "file";

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    return SAFE_WEB_PROTOCOLS.has(url.protocol) ||
      isRemoteEditorUrl(url) ||
      isLocalEditorFileUrl(url)
      ? Option.some(url.href)
      : Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
    /** Opens a known System Settings pane by identifier, not by URL. */
    readonly openSystemSettings: (pane: SystemSettingsPane) => Effect.Effect<boolean>;
    readonly copyText: (text: string) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/electron/ElectronShell") {}

export const make = ElectronShell.of({
  openExternal: (rawUrl) =>
    Option.match(parseSafeExternalUrl(rawUrl), {
      onNone: () => Effect.succeed(false),
      onSome: (externalUrl) =>
        Effect.promise(() =>
          Electron.shell.openExternal(externalUrl).then(
            () => true,
            () => false,
          ),
        ),
    }),
  openSystemSettings: (pane) =>
    Effect.promise(() =>
      Electron.shell.openExternal(SYSTEM_SETTINGS_URLS[pane]).then(
        () => true,
        () => false,
      ),
    ),
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
