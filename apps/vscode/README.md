# T3 Code for VS Code

![T3 Code in VS Code](media/screenshot.jpg)

> **Unofficial fork build.** This extension is published as `patroza.t3-code` from
> [patroza/t3code](https://github.com/patroza/t3code), a fork of
> [pingdotgg/t3code](https://github.com/pingdotgg/t3code). It is not published or supported by
> T3 Tools Inc. Report issues against
> [this fork's tracker](https://github.com/patroza/t3code/issues).

This package exposes T3 Code as a dedicated VS Code secondary-sidebar chat tab, alongside the
Claude Code, Chat, and Codex tabs. It connects directly to the same T3 Code server used by the web,
desktop, and mobile clients, so projects, threads, messages, turn state, and assistant streaming
remain synchronized. It also provides an optional native `@t3` participant inside VS Code Chat.

## Requirements

The extension is a client only — it needs a T3 Code backend to talk to. Either run T3 Desktop on the
same machine as the extension host, or point `t3Code.serverUrl` at a reachable T3 Code server.
VS Code 1.95 or newer is required.

## Development

1. Start T3 Code (`pnpm dev`), which listens at `http://127.0.0.1:3773` by default.
2. Build the extension with `pnpm --filter t3-code build`.
3. Open this repository in VS Code, choose **Run Extension** from the Run and Debug view, and point
   the extension-development host at `apps/vscode` if prompted.
4. Select the **T3 Code** tab in the secondary sidebar. Use **T3 Code: Open Chat** from the Command
   Palette if the secondary sidebar is hidden.

The extension first uses the backend advertised by the T3 Desktop runtime beside its extension
host. This works independently in local, SSH, and other remote windows and avoids treating a
synced `127.0.0.1` setting as the same machine. For a fallback backend, set `t3Code.serverUrl`.
Remote servers can use **T3 Code: Set Server Bearer Token**; the token is stored in VS Code secret
storage and exchanged for a short-lived WebSocket ticket.

## Dedicated chat workflow

The T3 Code tab contains a worktree-scoped thread picker, synchronized transcript, context control,
and prompt composer. Select a thread to continue it on any T3 client, or use **+** to create one for
the open worktree. Enter sends; Shift+Enter inserts a newline.

The same operations are also available through the optional native Chat participant:

- `@t3 /threads` selects an existing thread whose worktree matches the open workspace folder.
- `@t3 /new` creates a synchronized thread (and a project when the folder is not registered yet).
- A normal `@t3` prompt continues the last selected thread, or the most recently updated matching
  thread. If none exists, it creates one.
- `@t3 /history`, `/status`, and `/stop` inspect or control the selected server thread.

Active editor context is included by default and can be toggled from the composer, with
`@t3 /context`, or **T3 Code: Toggle Automatic Editor Context**. This preference is kept in VS Code's
extension state and never written to workspace settings. A non-empty
selection includes the exact character range; an empty selection includes the cursor line and
column. Explicit Chat references such as `#file` and attached selections are always included.

The **T3 Code: Ask About Selection** editor action opens Chat with `@t3` prefilled. Context is sent
as structured-looking provider context using workspace-relative paths and language-aware Markdown
fences. T3 Code clients present that envelope as a context reference rather than authored text.

## Releasing

The extension publishes to the `patroza` namespace on both the VS Code Marketplace and Open VSX.
Extension IDs and versions are shared between the two, so publish the same `.vsix` to each.

Bump `version` in `apps/vscode/package.json` and add a `CHANGELOG.md` entry first, then:

```sh
pnpm --filter t3-code package                 # -> t3-code-<version>.vsix
```

`package` runs the `vscode:prepublish` build and bundles `src/` with esbuild, so `--no-dependencies`
is passed deliberately: nothing from `node_modules` ships, and vsce never has to resolve the
`workspace:*` dependencies it cannot understand. The `--baseContentUrl` / `--baseImagesUrl` flags
make the README's relative links resolve against `apps/vscode/` on GitHub, which vsce cannot infer
for an extension living in a monorepo subdirectory.

Inspect the packaged contents before publishing:

```sh
pnpm --filter t3-code exec vsce ls --no-dependencies
```

Publishing needs a token per registry, neither of which is stored in this repo:

- **Marketplace** — an Azure DevOps PAT for the `patroza` publisher, with Marketplace: Manage scope.
  Pass it as `VSCE_PAT`, or run `vsce login patroza` once.
- **Open VSX** — an access token for the `patroza` namespace from <https://open-vsx.org/user-settings/tokens>.
  Pass it as `OVSX_PAT`. The namespace must be created once with `ovsx create-namespace patroza`.

```sh
VSCE_PAT=... pnpm --filter t3-code publish:vsce
OVSX_PAT=... pnpm --filter t3-code publish:ovsx t3-code-<version>.vsix
```

Tag the release as `vscode-v<version>` so extension tags do not collide with the `v*.*.*` tags that
drive the desktop release workflow.
