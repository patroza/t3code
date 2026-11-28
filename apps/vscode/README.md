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

The extension first uses the backend advertised by the T3 Desktop runtime beside its extension
host. This works independently in local, SSH, and other remote windows and avoids treating a
synced `127.0.0.1` setting as the same machine. For a fallback backend, set `t3Code.serverUrl`.
If the local T3 Desktop server or a remote server requires pairing, run **T3 Code: Pair with
Server…** (or click **Pair with Server…** in the sidebar) with a pairing URL or token from T3 Code
(Settings → Sharing & access, or `t3 pair`). You can also use **T3 Code: Set Server Bearer Token**
for a pre-issued access token; credentials are stored in VS Code secret storage and exchanged for
short-lived WebSocket tickets.

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
