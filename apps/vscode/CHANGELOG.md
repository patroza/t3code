# Changelog

All notable changes to the T3 Code VS Code extension are documented in this file.

## 0.0.38

- Add **T3 Code: Set Server URL**, which sets the server URL from the Command Palette, prefilled
  with the current value and validated before it is saved, and **T3 Code: Open Settings**, which
  opens the extension's settings.
- Document the server URL default (`http://127.0.0.1:3773`), when to change it, and every setting
  with its default. Expand the settings descriptions shown in the Settings UI.
- Fix the screenshot on the marketplace listing, which did not load in 0.0.37 because the packaged
  README's links pointed at a branch that did not yet contain the extension. Packaged README links
  are now pinned to the commit each version is built from.

## 0.0.37

Initial marketplace release of the `patroza` fork build.

- Dedicated T3 Code sidebar webview with a worktree-scoped thread picker, synchronized transcript,
  context control, and prompt composer.
- Native `@t3` VS Code Chat participant with `/new`, `/threads`, `/history`, `/context`, `/stop`,
  and `/status` commands.
- Realtime thread synchronization with the T3 Code web, desktop, and mobile clients.
- Editor context, slash commands, images, approvals, tools, and tasks.
- Connects to a local T3 Desktop runtime when advertised, otherwise falls back to `t3Code.serverUrl`
  (default `http://127.0.0.1:3773`). Remote servers authenticate with a bearer token held in VS Code
  secret storage.
