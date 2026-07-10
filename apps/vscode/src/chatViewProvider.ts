/* oxlint-disable unicorn/require-post-message-target-origin -- VS Code Webview.postMessage is not Window.postMessage. */
import type {
  ModelSelection,
  OrchestrationThread,
  OrchestrationThreadShell,
  RuntimeMode,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as vscode from "vscode";

import { composePrompt, type TextContext } from "./editorContext.ts";
import type { T3Client } from "./t3Client.ts";

interface ChatViewActions {
  readonly worktreePath: () => string;
  readonly ensureConnected: () => Promise<void>;
  readonly restoreThread: () => Promise<ThreadId | undefined>;
  readonly createThread: (title?: string, modelSelection?: ModelSelection) => Promise<ThreadId>;
  readonly selectThread: (threadId: string) => Promise<void>;
  readonly toggleContext: () => Promise<boolean>;
  readonly contextEnabled: () => boolean;
  readonly runtimeMode: () => RuntimeMode;
  readonly editorContext: () => TextContext | null;
}

type WebviewRequest =
  | { readonly type: "ready" | "refresh" | "stop" | "toggleContext" }
  | {
      readonly type: "sendNewThread";
      readonly text: string;
      readonly instanceId: string;
      readonly model: string;
      readonly options: ModelSelection["options"];
      readonly images: ReadonlyArray<UploadChatAttachment>;
    }
  | { readonly type: "selectThread"; readonly threadId: string }
  | {
      readonly type: "selectModel";
      readonly instanceId: string;
      readonly model: string;
      readonly options: ModelSelection["options"];
    }
  | { readonly type: "openLink"; readonly href: string }
  | { readonly type: "copyText"; readonly text: string }
  | {
      readonly type: "send";
      readonly text: string;
      readonly images: ReadonlyArray<UploadChatAttachment>;
    };

function hasImageArray(value: object): boolean {
  return (
    "images" in value &&
    Array.isArray(value.images) &&
    value.images.every(
      (image) =>
        typeof image === "object" &&
        image !== null &&
        "type" in image &&
        image.type === "image" &&
        "name" in image &&
        typeof image.name === "string" &&
        "mimeType" in image &&
        typeof image.mimeType === "string" &&
        "sizeBytes" in image &&
        typeof image.sizeBytes === "number" &&
        "dataUrl" in image &&
        typeof image.dataUrl === "string",
    )
  );
}

function nonce(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function threadState(thread: OrchestrationThreadShell): string {
  return thread.latestTurn?.state ?? thread.session?.status ?? "idle";
}

function isRequest(value: unknown): value is WebviewRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) return false;
  const type = (value as { readonly type?: unknown }).type;
  if (type === "ready" || type === "refresh" || type === "stop" || type === "toggleContext") {
    return true;
  }
  if (type === "sendNewThread") {
    return (
      "text" in value &&
      typeof value.text === "string" &&
      "instanceId" in value &&
      typeof value.instanceId === "string" &&
      "model" in value &&
      typeof value.model === "string" &&
      "options" in value &&
      (value.options === undefined || Array.isArray(value.options)) &&
      hasImageArray(value)
    );
  }
  if (type === "selectThread") {
    return "threadId" in value && typeof value.threadId === "string";
  }
  if (type === "selectModel") {
    return (
      "instanceId" in value &&
      typeof value.instanceId === "string" &&
      "model" in value &&
      typeof value.model === "string" &&
      "options" in value &&
      (value.options === undefined || Array.isArray(value.options))
    );
  }
  if (type === "openLink") return "href" in value && typeof value.href === "string";
  if (type === "copyText") return "text" in value && typeof value.text === "string";
  return (
    type === "send" && "text" in value && typeof value.text === "string" && hasImageArray(value)
  );
}

export class T3ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly primaryViewType = "t3Code.chatView";
  static readonly secondaryViewType = "t3Code.chatViewSecondary";

  #view: vscode.WebviewView | null = null;
  #busy = false;
  #error: string | null = null;
  readonly client: T3Client;
  readonly actions: ChatViewActions;
  readonly extensionUri: vscode.Uri;
  readonly #disposables: vscode.Disposable[];
  readonly #attachmentUrls = new Map<string, string>();
  readonly #attachmentLoads = new Set<string>();

  constructor(client: T3Client, actions: ChatViewActions, extensionUri: vscode.Uri) {
    this.client = client;
    this.actions = actions;
    this.extensionUri = extensionUri;
    this.#disposables = [
      client.onShellChanged(() => this.#publish()),
      client.onThreadChanged(() => this.#publish()),
      client.onConnectionChanged((connected) => {
        if (!connected) this.#error = "Connection lost. Refresh to reconnect to T3 Code.";
        this.#publish();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.#publish()),
      vscode.window.onDidChangeTextEditorSelection(() => this.#publish()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("t3Code")) void this.#refresh();
      }),
    ];
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.#view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = this.#html(view.webview);
    this.#disposables.push(
      view.webview.onDidReceiveMessage((message: unknown) => {
        if (isRequest(message)) void this.#handle(message);
      }),
      view.onDidDispose(() => {
        if (this.#view === view) this.#view = null;
      }),
      view.onDidChangeVisibility(() => {
        if (view.visible && this.client.serverConfig === null) void this.#refresh();
      }),
    );
  }

  dispose(): void {
    for (const disposable of this.#disposables) disposable.dispose();
    this.#disposables.length = 0;
  }

  async reveal(): Promise<void> {
    try {
      await vscode.commands.executeCommand(`${T3ChatViewProvider.secondaryViewType}.focus`);
    } catch {
      await vscode.commands.executeCommand(`${T3ChatViewProvider.primaryViewType}.focus`);
    }
    await this.#view?.webview.postMessage({ type: "focusComposer" });
  }

  async #handle(message: WebviewRequest): Promise<void> {
    try {
      switch (message.type) {
        case "ready":
        case "refresh":
          await this.#refresh();
          return;
        case "sendNewThread":
          await this.#run(async () => {
            const authored = message.text.trim();
            if (authored === "" && message.images.length === 0) return;
            const threadId = await this.actions.createThread(authored.slice(0, 80) || "Image", {
              instanceId: ProviderInstanceId.make(message.instanceId),
              model: message.model,
              ...(message.options === undefined ? {} : { options: message.options }),
            });
            const editorContext = this.actions.contextEnabled()
              ? this.actions.editorContext()
              : null;
            await this.client.sendPrompt({
              threadId,
              prompt: composePrompt(authored, editorContext === null ? [] : [editorContext]),
              runtimeMode: this.actions.runtimeMode(),
              attachments: message.images,
            });
            await this.#view?.webview.postMessage({ type: "sentNewThread" });
          });
          return;
        case "selectThread":
          await this.#run(async () => {
            await this.actions.selectThread(message.threadId);
            await this.client.waitForActiveThread();
          });
          return;
        case "selectModel":
          await this.#run(() =>
            this.client.setModelSelection({
              instanceId: ProviderInstanceId.make(message.instanceId),
              model: message.model,
              ...(message.options === undefined ? {} : { options: message.options }),
            }),
          );
          return;
        case "openLink":
          await this.#openLink(message.href);
          return;
        case "copyText":
          await vscode.env.clipboard.writeText(message.text);
          return;
        case "stop":
          await this.#run(() => this.client.interrupt());
          return;
        case "toggleContext":
          await this.actions.toggleContext();
          this.#publish();
          return;
        case "send": {
          const authored = message.text.trim();
          if (authored === "" && message.images.length === 0) return;
          await this.#run(async () => {
            await this.actions.ensureConnected();
            const threadId =
              this.client.activeThread?.id ??
              (await this.actions.restoreThread()) ??
              (await this.actions.createThread(authored.slice(0, 80)));
            const context = this.actions.contextEnabled() ? this.actions.editorContext() : null;
            await this.client.sendPrompt({
              threadId,
              prompt: composePrompt(authored, context === null ? [] : [context]),
              runtimeMode: this.actions.runtimeMode(),
              attachments: message.images,
            });
            await this.#view?.webview.postMessage({ type: "sent" });
          });
          return;
        }
      }
    } catch (cause) {
      this.#error = cause instanceof Error ? cause.message : String(cause);
      this.#publish();
    }
  }

  async #refresh(): Promise<void> {
    await this.#run(async () => {
      await this.actions.ensureConnected();
      await this.actions.restoreThread();
    });
  }

  async #run(action: () => Promise<void>): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.#error = null;
    this.#publish();
    try {
      await action();
    } catch (cause) {
      this.#error = cause instanceof Error ? cause.message : String(cause);
    } finally {
      this.#busy = false;
      this.#publish();
    }
  }

  #publish(): void {
    const view = this.#view;
    if (view === null) return;
    let threads: ReadonlyArray<OrchestrationThreadShell> = [];
    try {
      threads = this.client.threadsForWorktree(this.actions.worktreePath());
    } catch {
      // The empty-workspace message below is more useful than surfacing this as a connection error.
    }
    const editorContext = this.actions.editorContext();
    this.#loadAttachmentUrls(this.client.activeThread);
    void view.webview.postMessage({
      type: "state",
      state: {
        busy: this.#busy,
        error: this.#error,
        connected: this.client.serverConfig !== null,
        environmentLabel: this.client.serverConfig?.environment.label ?? "T3 Code",
        threads: threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          model: thread.modelSelection.model,
          state: threadState(thread),
          updatedAt: thread.updatedAt,
        })),
        activeThread: this.#serializeThread(this.client.activeThread),
        models:
          this.client.serverConfig?.providers
            .filter((provider) => provider.enabled && provider.installed)
            .flatMap((provider) =>
              provider.models.map((model) => ({
                instanceId: provider.instanceId,
                model: model.slug,
                label: `${provider.displayName ?? provider.driver} · ${model.name}`,
                optionDescriptors: model.capabilities?.optionDescriptors ?? [],
              })),
            ) ?? [],
        contextEnabled: this.actions.contextEnabled(),
        editorContext:
          editorContext === null
            ? null
            : {
                path: editorContext.relativePath,
                startLine: editorContext.startLine,
                endLine: editorContext.endLine,
                kind: editorContext.kind,
              },
      },
    });
  }

  #serializeThread(thread: OrchestrationThread | null) {
    if (thread === null) return null;
    return {
      id: thread.id,
      title: thread.title,
      model: thread.modelSelection.model,
      instanceId: thread.modelSelection.instanceId,
      runtimeMode: thread.runtimeMode,
      state: thread.latestTurn?.state ?? thread.session?.status ?? "idle",
      messages: thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        streaming: message.streaming,
        attachments: (message.attachments ?? []).map((attachment) => ({
          ...attachment,
          previewUrl: this.#attachmentUrls.get(attachment.id) ?? null,
        })),
      })),
    };
  }

  #loadAttachmentUrls(thread: OrchestrationThread | null): void {
    for (const message of thread?.messages ?? []) {
      for (const attachment of message.attachments ?? []) {
        if (this.#attachmentUrls.has(attachment.id) || this.#attachmentLoads.has(attachment.id)) {
          continue;
        }
        this.#attachmentLoads.add(attachment.id);
        void this.client
          .createAttachmentUrl(attachment.id)
          .then((url) => this.#attachmentUrls.set(attachment.id, url))
          .catch(() => undefined)
          .finally(() => {
            this.#attachmentLoads.delete(attachment.id);
            this.#publish();
          });
      }
    }
  }

  async #openLink(rawHref: string): Promise<void> {
    const href = rawHref.trim();
    if (href === "" || href.startsWith("#")) return;
    if (/^https?:\/\//iu.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    if (/^[a-z][a-z0-9+.-]*:/iu.test(href) && !href.startsWith("file:")) return;
    const [pathPart = "", fragment = ""] = href.replace(/^file:\/\//iu, "").split("#", 2);
    const uri = pathPart.startsWith("/")
      ? vscode.Uri.file(pathPart)
      : vscode.Uri.joinPath(vscode.Uri.file(this.actions.worktreePath()), pathPart);
    const document = await vscode.workspace.openTextDocument(uri);
    const lineMatch = /^(?:L)?(\d+)/u.exec(fragment);
    const line = Math.max(0, Number(lineMatch?.[1] ?? 1) - 1);
    await vscode.window.showTextDocument(document, {
      selection: new vscode.Range(line, 0, line, 0),
      preview: true,
    });
  }

  #html(webview: vscode.Webview): string {
    const scriptNonce = nonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview.js"),
    );
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} http: https: data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${scriptNonce}';" />
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font: var(--vscode-font-size) var(--vscode-font-family); height: 100vh; overflow: hidden; }
    button, select, textarea { font: inherit; color: inherit; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 5px; padding: 5px 8px; cursor: pointer; }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .5; cursor: default; }
    #app { height: 100%; display: grid; grid-template-rows: auto auto 1fr auto; }
    .toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; padding: 10px; border-bottom: 1px solid var(--vscode-sideBar-border); }
    select { width: 100%; min-width: 0; border: 1px solid var(--vscode-dropdown-border); background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border-radius: 4px; padding: 5px 7px; }
    #status { min-height: 0; padding: 0 10px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    #status.error { color: var(--vscode-errorForeground); padding-top: 7px; padding-bottom: 7px; }
    #status.working { padding-top: 6px; padding-bottom: 2px; }
    #status.working::after { content: '…'; display: inline-block; width: 1.2em; overflow: hidden; vertical-align: bottom; animation: working-dots 1.2s steps(4, end) infinite; }
    @keyframes working-dots { from { width: 0; } to { width: 1.2em; } }
    #messages { overflow-y: auto; padding: 12px 10px 18px; display: flex; flex-direction: column; gap: 14px; }
    .empty { margin: auto; max-width: 260px; text-align: center; color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .message { min-width: 0; }
    .message.user { align-self: flex-end; max-width: 92%; border-radius: 12px 12px 3px 12px; padding: 8px 10px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .message.assistant, .message.system { align-self: stretch; }
    .role { color: var(--vscode-descriptionForeground); font-size: 10px; font-weight: 600; text-transform: uppercase; margin-bottom: 4px; }
    .content { overflow-wrap: anywhere; line-height: 1.55; }
    .markdown-body > :first-child { margin-top: 0; }
    .markdown-body > :last-child { margin-bottom: 0; }
    .markdown-body p, .markdown-body ul, .markdown-body ol, .markdown-body blockquote, .markdown-body pre, .markdown-body table { margin: .65em 0; }
    .markdown-body h1, .markdown-body h2, .markdown-body h3, .markdown-body h4 { line-height: 1.25; margin: 1.1em 0 .45em; color: var(--vscode-foreground); }
    .markdown-body h1 { font-size: 1.45em; padding-bottom: .25em; border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .markdown-body h2 { font-size: 1.25em; padding-bottom: .2em; border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .markdown-body h3 { font-size: 1.1em; }
    .markdown-body ul, .markdown-body ol { padding-left: 1.7em; }
    .markdown-body li + li { margin-top: .25em; }
    .markdown-body blockquote { margin-left: 0; padding: .1em 0 .1em .85em; border-left: 3px solid var(--vscode-textBlockQuote-border); color: var(--vscode-textBlockQuote-foreground); background: var(--vscode-textBlockQuote-background); }
    .markdown-body a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .markdown-body a:hover { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
    .markdown-body code { font-family: var(--vscode-editor-font-family); font-size: .92em; background: var(--vscode-textCodeBlock-background); border-radius: 4px; padding: .12em .35em; }
    .markdown-body pre { overflow: auto; padding: 10px 12px; margin: 0; background: var(--vscode-textCodeBlock-background); border-radius: 0 0 6px 6px; }
    .markdown-body pre code { padding: 0; background: transparent; border-radius: 0; white-space: pre; }
    .code-block { margin: .8em 0; border: 1px solid var(--vscode-editorWidget-border); border-radius: 6px; overflow: hidden; }
    .code-header { display: flex; align-items: center; justify-content: space-between; min-height: 28px; padding: 3px 6px 3px 10px; color: var(--vscode-descriptionForeground); background: var(--vscode-editorGroupHeader-tabsBackground); font-size: 11px; }
    .copy-code { padding: 2px 6px; border: 0; background: transparent; color: var(--vscode-descriptionForeground); }
    .table-scroll { overflow-x: auto; margin: .8em 0; }
    .markdown-body table { width: 100%; border-collapse: collapse; margin: 0; }
    .markdown-body th, .markdown-body td { padding: 6px 8px; border: 1px solid var(--vscode-editorWidget-border); text-align: left; vertical-align: top; }
    .markdown-body th { background: var(--vscode-editorGroupHeader-tabsBackground); font-weight: 600; }
    .markdown-body hr { border: 0; border-top: 1px solid var(--vscode-editorWidget-border); margin: 1em 0; }
    .markdown-body input[type='checkbox'] { margin: 0 .45em 0 0; }
    .attachments { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 8px; margin-top: 8px; }
    .attachment { display: block; overflow: hidden; min-height: 80px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 7px; background: var(--vscode-textCodeBlock-background); }
    .attachment img { display: block; width: 100%; max-height: 260px; object-fit: contain; }
    .attachment-name { display: block; padding: 5px 7px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    .streaming::after { content: '▋'; animation: blink 1s steps(1) infinite; }
    @keyframes blink { 50% { opacity: 0; } }
    .composer { border-top: 1px solid var(--vscode-sideBar-border); padding: 8px 10px 10px; background: var(--vscode-sideBar-background); }
    #pending-attachments { display: flex; gap: 7px; overflow-x: auto; margin-bottom: 6px; }
    .pending-attachment { display: grid; grid-template-columns: 38px minmax(60px, 120px) auto; align-items: center; gap: 6px; flex: 0 0 auto; padding: 4px; border: 1px solid var(--vscode-input-border); border-radius: 6px; background: var(--vscode-input-background); }
    .pending-attachment img { width: 38px; height: 38px; border-radius: 4px; object-fit: cover; }
    .pending-attachment span { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .pending-attachment button { border: 0; padding: 2px 5px; background: transparent; font-size: 16px; }
    .context { display: flex; align-items: center; gap: 6px; min-height: 24px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .context button { border: 0; background: transparent; padding: 2px 0; color: inherit; }
    textarea { width: 100%; min-height: 72px; max-height: 220px; resize: vertical; border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 8px; outline: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    textarea:focus { border-color: var(--vscode-focusBorder); }
    .composer-actions { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 8px; margin-top: 7px; }
    #model { border: 0; padding-left: 0; color: var(--vscode-descriptionForeground); background: transparent; font-size: 11px; }
    #model-options { display: flex; flex-wrap: wrap; gap: 6px 12px; margin: 3px 0 6px; }
    .model-option { display: flex; align-items: center; gap: 5px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .model-option select { width: auto; padding: 2px 4px; }
    #send.stop-action { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  </style>
</head>
<body>
  <div id="app">
    <div class="toolbar">
      <select id="threads" aria-label="T3 Code thread"><option>Loading threads…</option></select>
      <button id="new" title="New synchronized thread">＋</button>
      <button id="refresh" title="Refresh">↻</button>
    </div>
    <div id="status"></div>
    <main id="messages"><div class="empty">Connecting to T3 Code…</div></main>
    <div class="composer">
      <div id="pending-attachments"></div>
      <div class="context"><button id="context" title="Toggle automatic editor context">◉ Context</button><span id="context-label"></span></div>
      <div id="model-options"></div>
      <textarea id="prompt" placeholder="Ask T3 Code…" aria-label="Message T3 Code"></textarea>
      <div class="composer-actions"><select id="model" aria-label="Thread model"><option>Select a thread</option></select><button class="primary" id="send">Send</button></div>
    </div>
  </div>
  <script nonce="${scriptNonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
