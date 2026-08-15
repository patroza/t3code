import { REMOTE_CAPABLE_EDITOR_IDS, remoteSchemeForEditor } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

const SAFE_EXTERNAL_PROTOCOLS = new Set(["http:", "https:"]);
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

export function parseSafeExternalUrl(rawUrl: unknown): Option.Option<string> {
  if (typeof rawUrl !== "string") {
    return Option.none();
  }

  try {
    const url = new URL(rawUrl);
    if (SAFE_EXTERNAL_PROTOCOLS.has(url.protocol)) {
      return Option.some(url.href);
    }
    if (SAFE_EDITOR_PROTOCOLS.has(url.protocol)) {
      // Local open: `<editor>://file/<absolute path>`.
      if (url.hostname === "file") {
        return Option.some(url.href);
      }
      // Remote-SSH open: `<editor>://vscode-remote/ssh-remote+<authority>/<path>`.
      if (url.hostname === "vscode-remote" && url.pathname.startsWith("/ssh-remote+")) {
        return Option.some(url.href);
      }
      return Option.none();
    }
    return Option.none();
  } catch {
    return Option.none();
  }
}

export class ElectronShell extends Context.Service<
  ElectronShell,
  {
    readonly openExternal: (rawUrl: unknown) => Effect.Effect<boolean>;
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
  copyText: (text) =>
    Effect.sync(() => {
      Electron.clipboard.writeText(text);
    }),
});

export const layer = Layer.succeed(ElectronShell, make);
