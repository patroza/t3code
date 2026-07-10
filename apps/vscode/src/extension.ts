// @effect-diagnostics globalDate:off
import type {
  ModelSelection,
  OrchestrationMessage,
  OrchestrationThread,
  OrchestrationThreadShell,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as vscode from "vscode";

import { composePrompt, type TextContext } from "./editorContext.ts";
import { T3ChatViewProvider } from "./chatViewProvider.ts";
import { T3Client } from "./t3Client.ts";

const ACTIVE_THREAD_KEY_PREFIX = "t3Code.activeThread";
const BEARER_TOKEN_SECRET = "t3Code.serverBearerToken";

function workspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  return (
    (activeUri === undefined ? undefined : vscode.workspace.getWorkspaceFolder(activeUri)) ??
    vscode.workspace.workspaceFolders?.[0]
  );
}

function worktreePath(): string {
  const folder = workspaceFolder();
  if (folder === undefined) throw new Error("Open a workspace folder before using T3 Code.");
  return folder.uri.fsPath;
}

function activeThreadStorageKey(): string {
  return `${ACTIVE_THREAD_KEY_PREFIX}:${workspaceFolder()?.uri.toString() ?? "none"}`;
}

function relativePath(uri: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  return folder === undefined ? uri.fsPath : vscode.workspace.asRelativePath(uri, false);
}

function languageFor(uri: vscode.Uri, fallback = "text"): string {
  return (
    vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())
      ?.languageId ?? fallback
  );
}

function activeEditorContext(): TextContext | null {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined || editor.document.uri.scheme !== "file") return null;
  const selection = editor.selection;
  if (!selection.isEmpty) {
    return {
      relativePath: relativePath(editor.document.uri),
      languageId: editor.document.languageId,
      text: editor.document.getText(selection),
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
      kind: "selection",
    };
  }
  const line = editor.document.lineAt(selection.active.line);
  return {
    relativePath: relativePath(editor.document.uri),
    languageId: editor.document.languageId,
    text: line.text,
    startLine: line.lineNumber + 1,
    endLine: line.lineNumber + 1,
    cursorColumn: selection.active.character + 1,
    kind: "cursor-line",
  };
}

async function referenceContexts(
  references: ReadonlyArray<vscode.ChatPromptReference>,
): Promise<ReadonlyArray<TextContext>> {
  const contexts: TextContext[] = [];
  for (const reference of references.toReversed()) {
    const value = reference.value;
    if (value instanceof vscode.Location) {
      const document = await vscode.workspace.openTextDocument(value.uri);
      contexts.push({
        relativePath: relativePath(value.uri),
        languageId: document.languageId,
        text: document.getText(value.range),
        startLine: value.range.start.line + 1,
        endLine: value.range.end.line + 1,
        kind: "reference",
      });
    } else if (value instanceof vscode.Uri && value.scheme === "file") {
      const document = await vscode.workspace.openTextDocument(value);
      contexts.push({
        relativePath: relativePath(value),
        languageId: languageFor(value, document.languageId),
        text: document.getText(),
        startLine: 1,
        endLine: document.lineCount,
        kind: "reference",
      });
    } else if (typeof value === "string" && value.trim() !== "") {
      contexts.push({
        relativePath: reference.modelDescription ?? reference.id,
        languageId: "text",
        text: value,
        startLine: 1,
        endLine: 1,
        kind: "reference",
      });
    }
  }
  return contexts;
}

function configuration(): {
  readonly serverUrl: string;
  readonly includeEditorContext: boolean;
  readonly runtimeMode: RuntimeMode;
} {
  const config = vscode.workspace.getConfiguration("t3Code");
  return {
    serverUrl: config.get("serverUrl", "http://127.0.0.1:3773"),
    includeEditorContext: config.get("includeEditorContext", true),
    runtimeMode: config.get<RuntimeMode>("defaultRuntimeMode", "full-access"),
  };
}

function threadLabel(
  thread: OrchestrationThreadShell,
): vscode.QuickPickItem & { threadId: ThreadId } {
  const state = thread.latestTurn?.state ?? thread.session?.status ?? "idle";
  return {
    label: thread.title,
    description: state,
    detail: `${thread.modelSelection.model} · ${new Date(thread.updatedAt).toLocaleString()}`,
    threadId: thread.id,
  };
}

function renderHistory(thread: OrchestrationThread): string {
  if (thread.messages.length === 0) return "_No messages yet._";
  return thread.messages
    .map(
      (message) =>
        `**${message.role === "assistant" ? "T3 Code" : message.role}**\n\n${message.text}`,
    )
    .join("\n\n---\n\n");
}

function newestAssistantMessage(thread: OrchestrationThread): OrchestrationMessage | null {
  return thread.messages.findLast((message) => message.role === "assistant") ?? null;
}

export function activate(context: vscode.ExtensionContext): void {
  const client = new T3Client();
  const [major = 1, minor = 0] = vscode.version.split(".").map(Number);
  const supportsSecondarySidebar = major > 1 || (major === 1 && minor >= 106);
  void vscode.commands.executeCommand(
    "setContext",
    "t3Code.useActivityBar",
    !supportsSecondarySidebar,
  );

  const ensureConnected = async (): Promise<void> => {
    const config = configuration();
    await client.connect(config.serverUrl, await context.secrets.get(BEARER_TOKEN_SECRET));
    await client.waitForShell();
  };

  const rememberThread = async (threadId: ThreadId): Promise<void> => {
    await context.workspaceState.update(activeThreadStorageKey(), threadId);
  };

  const selectThread = async (): Promise<ThreadId | undefined> => {
    await ensureConnected();
    const threads = client.threadsForWorktree(worktreePath());
    if (threads.length === 0) {
      void vscode.window.showInformationMessage("No T3 Code threads exist for this worktree yet.");
      return undefined;
    }
    const picked = await vscode.window.showQuickPick(threads.map(threadLabel), {
      title: "T3 Code threads for this worktree",
      placeHolder: "Choose a synchronized thread",
    });
    if (picked === undefined) return undefined;
    await client.selectThread(picked.threadId);
    await client.waitForActiveThread();
    await rememberThread(picked.threadId);
    return picked.threadId;
  };

  const createThread = async (
    title = "New thread",
    modelSelection?: ModelSelection,
  ): Promise<ThreadId> => {
    await ensureConnected();
    const threadId = await client.createThreadForWorktree({
      worktreePath: worktreePath(),
      title,
      runtimeMode: configuration().runtimeMode,
      ...(modelSelection === undefined ? {} : { modelSelection }),
    });
    await rememberThread(threadId);
    return threadId;
  };

  const restoreThread = async (): Promise<ThreadId | undefined> => {
    await ensureConnected();
    const stored = context.workspaceState.get<string>(activeThreadStorageKey());
    const threads = client.threadsForWorktree(worktreePath());
    const thread = threads.find((candidate) => candidate.id === stored) ?? threads[0];
    if (thread === undefined) return undefined;
    await client.selectThread(thread.id);
    await client.waitForActiveThread();
    await rememberThread(thread.id);
    return thread.id;
  };

  const toggleContext = async (): Promise<boolean> => {
    const config = vscode.workspace.getConfiguration("t3Code");
    const next = !config.get("includeEditorContext", true);
    await config.update("includeEditorContext", next, vscode.ConfigurationTarget.Workspace);
    void vscode.window.showInformationMessage(
      `Automatic T3 editor context ${next ? "enabled" : "disabled"}.`,
    );
    return next;
  };

  const selectThreadById = async (threadId: string): Promise<void> => {
    await ensureConnected();
    const thread = client.shell?.threads.find((candidate) => candidate.id === threadId);
    if (thread === undefined) throw new Error("The selected T3 Code thread no longer exists.");
    await client.selectThread(thread.id);
    await client.waitForActiveThread();
    await rememberThread(thread.id);
  };

  const chatView = new T3ChatViewProvider(
    client,
    {
      worktreePath,
      ensureConnected,
      restoreThread,
      createThread,
      selectThread: selectThreadById,
      toggleContext,
      contextEnabled: () => configuration().includeEditorContext,
      runtimeMode: () => configuration().runtimeMode,
      editorContext: activeEditorContext,
    },
    context.extensionUri,
  );

  const handler: vscode.ChatRequestHandler = async (request, _chatContext, response, token) => {
    try {
      if (request.command === "context") {
        const enabled = await toggleContext();
        response.markdown(
          `Automatic active-editor context is now **${enabled ? "on" : "off"}**. Explicit \`#file\` and selection references are always included.`,
        );
        return;
      }
      if (request.command === "threads") {
        const selected = await selectThread();
        if (selected !== undefined)
          response.markdown(`Selected synchronized thread \`${selected}\`.`);
        return;
      }
      if (request.command === "new") {
        const title = request.prompt.trim() || "New thread";
        const threadId = await createThread(title.slice(0, 80));
        response.markdown(
          `Created synchronized thread **${title.slice(0, 80)}** (\`${threadId}\`).`,
        );
        return;
      }
      const threadId =
        (await restoreThread()) ??
        (await createThread(request.prompt.trim().slice(0, 80) || "New thread"));
      if (request.command === "history") {
        response.markdown(renderHistory(await client.waitForActiveThread()));
        return;
      }
      if (request.command === "status") {
        const thread = await client.waitForActiveThread();
        response.markdown(
          `Connected to **${client.serverConfig?.environment.label ?? "T3 Code"}**.\n\nThread: **${thread.title}**  \nModel: \`${thread.modelSelection.model}\`  \nRuntime: \`${thread.runtimeMode}\`  \nState: \`${thread.latestTurn?.state ?? thread.session?.status ?? "idle"}\``,
        );
        return;
      }
      if (request.command === "stop") {
        await client.interrupt();
        response.markdown("Interrupt requested.");
        return;
      }

      const config = configuration();
      const explicit = await referenceContexts(request.references);
      const automatic = config.includeEditorContext ? activeEditorContext() : null;
      const contexts = automatic === null ? explicit : [automatic, ...explicit];
      const prompt = composePrompt(request.prompt, contexts);
      for (const reference of request.references) {
        if (reference.value instanceof vscode.Uri) response.reference(reference.value);
        else if (reference.value instanceof vscode.Location) response.reference(reference.value);
      }

      const initial = client.activeThread;
      const initialAssistant = initial === null ? null : newestAssistantMessage(initial);
      const initialTurnId = initial?.latestTurn?.turnId ?? null;
      let emitted = "";
      let turnObserved = false;
      let finished = false;
      let disposeThreadChange = (): void => {};
      response.progress(`Sending to ${initial?.modelSelection.model ?? "T3 Code"}…`);

      const completion = new Promise<void>((resolve, reject) => {
        const disposable = client.onThreadChanged((thread) => {
          if (thread === null || finished) return;
          const turn = thread.latestTurn;
          if (turn !== null && (turn.state === "running" || turn.turnId !== initialTurnId)) {
            turnObserved = true;
          }
          const assistant = newestAssistantMessage(thread);
          if (assistant !== null && assistant.id !== initialAssistant?.id) {
            const next = assistant.text;
            if (next.startsWith(emitted)) response.markdown(next.slice(emitted.length));
            else if (next !== emitted) response.markdown(`\n\n${next}`);
            emitted = next;
          }
          if (turnObserved && turn !== null && turn.state !== "running") {
            finished = true;
            disposable.dispose();
            if (turn.state === "error")
              reject(new Error(thread.session?.lastError ?? "The T3 Code turn failed."));
            else resolve();
          }
        });
        token.onCancellationRequested(() => {
          if (finished) return;
          finished = true;
          disposable.dispose();
          void client.interrupt().finally(resolve);
        });
        disposeThreadChange = () => disposable.dispose();
      });
      try {
        await client.sendPrompt({ threadId, prompt, runtimeMode: config.runtimeMode });
        await completion;
      } finally {
        disposeThreadChange();
      }
      if (emitted === "") response.markdown("_Turn completed without an assistant message._");
      return { metadata: { threadId } };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      response.markdown(`$(error) ${message}`);
      return { errorDetails: { message } };
    }
  };

  const participant = vscode.chat.createChatParticipant("t3-code.chat", handler);
  participant.iconPath = new vscode.ThemeIcon("comment-discussion");
  context.subscriptions.push(
    chatView,
    vscode.window.registerWebviewViewProvider(T3ChatViewProvider.primaryViewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(T3ChatViewProvider.secondaryViewType, chatView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    participant,
    vscode.commands.registerCommand("t3Code.newThread", async () => {
      const title = await vscode.window.showInputBox({
        prompt: "Thread title",
        value: "New thread",
      });
      if (title !== undefined) await createThread(title.trim() || "New thread");
    }),
    vscode.commands.registerCommand("t3Code.selectThread", selectThread),
    vscode.commands.registerCommand("t3Code.toggleEditorContext", toggleContext),
    vscode.commands.registerCommand("t3Code.askSelection", async () => {
      await chatView.reveal();
    }),
    vscode.commands.registerCommand("t3Code.openChat", () => chatView.reveal()),
    vscode.commands.registerCommand("t3Code.setBearerToken", async () => {
      const token = await vscode.window.showInputBox({
        prompt: "T3 Code server bearer token",
        password: true,
        ignoreFocusOut: true,
      });
      if (token !== undefined && token.trim() !== "") {
        await context.secrets.store(BEARER_TOKEN_SECRET, token.trim());
        void vscode.window.showInformationMessage(
          "T3 Code bearer token stored in VS Code secret storage.",
        );
      }
    }),
    vscode.commands.registerCommand("t3Code.clearBearerToken", async () => {
      await context.secrets.delete(BEARER_TOKEN_SECRET);
      void vscode.window.showInformationMessage("T3 Code bearer token cleared.");
    }),
    { dispose: () => void client.dispose() },
  );
}

export function deactivate(): void {}
