# Changelog

All notable changes to the T3 Code VS Code extension are documented in this file.

## 0.0.37

Initial marketplace release of the `patroza` fork build.

- Dedicated T3 Code sidebar webview with a worktree-scoped thread picker, synchronized transcript,
  context control, and prompt composer.
- Native `@t3` VS Code Chat participant with `/new`, `/threads`, `/history`, `/context`, `/stop`,
  and `/status` commands.
- Realtime thread synchronization with the T3 Code web, desktop, and mobile clients.
- Editor context, slash commands, images, approvals, tools, and tasks.
- Connects to a local T3 Desktop runtime when advertised, otherwise falls back to `t3Code.serverUrl`.
  Remote servers authenticate with a bearer token held in VS Code secret storage.
