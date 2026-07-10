# T3 Code for VS Code

This package exposes T3 Code as a dedicated VS Code secondary-sidebar chat tab, alongside the
Claude Code, Chat, and Codex tabs. It connects directly to the same T3 Code server used by the web,
desktop, and mobile clients, so projects, threads, messages, turn state, and assistant streaming
remain synchronized. It also provides an optional native `@t3` participant inside VS Code Chat.

## Development

1. Start T3 Code (`pnpm dev`), which listens at `http://127.0.0.1:3773` by default.
2. Build the extension with `pnpm --filter t3-code build`.
3. Open this repository in VS Code, choose **Run Extension** from the Run and Debug view, and point
   the extension-development host at `apps/vscode` if prompted.
4. Select the **T3 Code** tab in the secondary sidebar. Use **T3 Code: Open Chat** from the Command
   Palette if the secondary sidebar is hidden.

For a different backend, set `t3Code.serverUrl`. Remote servers can use **T3 Code: Set Server
Bearer Token**; the token is stored in VS Code secret storage and exchanged for a short-lived
WebSocket ticket.

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

Automatic editor context is enabled by default and can be disabled with `@t3 /context`, **T3 Code:
Toggle Automatic Editor Context**, or the `t3Code.includeEditorContext` setting. A non-empty
selection includes the exact character range; an empty selection includes the cursor line and
column. Explicit Chat references such as `#file` and attached selections are always included.

The **T3 Code: Ask About Selection** editor action opens Chat with `@t3` prefilled. Context is sent
inside a clearly delimited `<editor_context>` section using workspace-relative paths and language
aware Markdown fences, so it is preserved in the synchronized T3 thread history.
