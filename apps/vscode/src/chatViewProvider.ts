/* oxlint-disable unicorn/require-post-message-target-origin -- VS Code Webview.postMessage is not Window.postMessage. */
import type {
  ModelSelection,
  OrchestrationThread,
  OrchestrationThreadShell,
  RuntimeMode,
  ThreadId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { ApprovalRequestId, ProviderInstanceId } from "@t3tools/contracts";
import * as vscode from "vscode";

import { composePrompt, type TextContext } from "./editorContext.ts";
import { derivePendingInteractions } from "./pendingInteractions.ts";
import type { T3Client } from "./t3Client.ts";
import { resolveThreadDisplayStatus } from "./threadStatus.ts";
import { presentTasks } from "./taskPresentation.ts";
import { presentToolCalls } from "./toolPresentation.ts";
import { presentResolvedUserInputs } from "./userInputPresentation.ts";
import { deriveContextWindowUsage } from "./usagePresentation.ts";

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
  readonly favoriteProviderIds: () => ReadonlyArray<string>;
  readonly favoriteModelKeys: () => ReadonlyArray<string>;
  readonly toggleProviderFavorite: (instanceId: string) => Promise<void>;
  readonly toggleModelFavorite: (modelKey: string) => Promise<void>;
  readonly onFavoritesChanged: vscode.Event<void>;
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
  | { readonly type: "openEditorContext"; readonly path: string; readonly detail: string }
  | { readonly type: "copyText"; readonly text: string }
  | {
      readonly type: "approvalResponse";
      readonly requestId: string;
      readonly decision: "accept" | "acceptForSession" | "decline";
    }
  | {
      readonly type: "userInputResponse";
      readonly requestId: string;
      readonly answers: Readonly<Record<string, string | ReadonlyArray<string>>>;
    }
  | { readonly type: "toggleProviderFavorite"; readonly instanceId: string }
  | { readonly type: "toggleModelFavorite"; readonly modelKey: string }
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
  if (type === "approvalResponse") {
    return (
      "requestId" in value &&
      typeof value.requestId === "string" &&
      "decision" in value &&
      (value.decision === "accept" ||
        value.decision === "acceptForSession" ||
        value.decision === "decline")
    );
  }
  if (type === "userInputResponse") {
    return (
      "requestId" in value &&
      typeof value.requestId === "string" &&
      "answers" in value &&
      typeof value.answers === "object" &&
      value.answers !== null &&
      Object.values(value.answers).every(
        (answer) =>
          typeof answer === "string" ||
          (Array.isArray(answer) && answer.every((entry) => typeof entry === "string")),
      )
    );
  }
  if (type === "openEditorContext") {
    return (
      "path" in value &&
      typeof value.path === "string" &&
      "detail" in value &&
      typeof value.detail === "string"
    );
  }
  if (type === "copyText") return "text" in value && typeof value.text === "string";
  if (type === "toggleProviderFavorite") {
    return "instanceId" in value && typeof value.instanceId === "string";
  }
  if (type === "toggleModelFavorite") {
    return "modelKey" in value && typeof value.modelKey === "string";
  }
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
      client.onAiUsageChanged(() => this.#publish()),
      client.onConnectionChanged((connected) => {
        if (!connected) this.#error = "Connection lost. Refresh to reconnect to T3 Code.";
        this.#publish();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.#publish()),
      vscode.window.onDidChangeTextEditorSelection(() => this.#publish()),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("t3Code")) void this.#refresh();
      }),
      actions.onFavoritesChanged(() => this.#publish()),
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
            const modelSelection: ModelSelection = {
              instanceId: ProviderInstanceId.make(message.instanceId),
              model: message.model,
              ...(message.options === undefined ? {} : { options: message.options }),
            };
            const threadId = await this.actions.createThread(
              authored.slice(0, 80) || "Image",
              modelSelection,
            );
            const editorContext = this.actions.contextEnabled()
              ? this.actions.editorContext()
              : null;
            await this.client.sendPrompt({
              threadId,
              prompt: composePrompt(authored, editorContext === null ? [] : [editorContext]),
              runtimeMode: this.actions.runtimeMode(),
              modelSelection,
              attachments: message.images,
            });
            // The shell/title update can arrive before the detail stream. Hydrate
            // the authoritative first message before the webview leaves draft mode.
            await this.client.selectThread(threadId);
            await this.client.waitForActiveThread();
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
        case "openEditorContext": {
          if (message.path.split("/").includes("..")) return;
          const uri = vscode.Uri.joinPath(
            vscode.Uri.file(this.actions.worktreePath()),
            ...message.path.split("/"),
          );
          const document = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(document);
          const line = /(?:line|lines)\s+(\d+)/u.exec(message.detail)?.[1];
          if (line !== undefined) {
            const position = new vscode.Position(Math.max(0, Number(line) - 1), 0);
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position));
          }
          return;
        }
        case "copyText":
          await vscode.env.clipboard.writeText(message.text);
          return;
        case "approvalResponse":
          await this.#run(() =>
            this.client.respondToApproval(
              ApprovalRequestId.make(message.requestId),
              message.decision,
            ),
          );
          return;
        case "userInputResponse":
          await this.#run(() =>
            this.client.respondToUserInput(ApprovalRequestId.make(message.requestId), {
              ...message.answers,
            }),
          );
          return;
        case "toggleProviderFavorite":
          await this.actions.toggleProviderFavorite(message.instanceId);
          this.#publish();
          return;
        case "toggleModelFavorite":
          await this.actions.toggleModelFavorite(message.modelKey);
          this.#publish();
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
          status: resolveThreadDisplayStatus(thread),
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
                driver: provider.driver,
                providerLabel: provider.displayName ?? provider.driver,
                modelLabel: model.name,
                optionDescriptors: model.capabilities?.optionDescriptors ?? [],
              })),
            ) ?? [],
        aiUsage: this.client.aiUsage,
        favoriteProviderIds: this.actions.favoriteProviderIds(),
        favoriteModelKeys: this.actions.favoriteModelKeys(),
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
      status: resolveThreadDisplayStatus({
        latestTurn: thread.latestTurn,
        session: thread.session,
      }),
      turnStartedAt: thread.latestTurn?.startedAt ?? thread.latestTurn?.requestedAt ?? null,
      contextWindow: deriveContextWindowUsage(thread.activities),
      pendingInteractions: derivePendingInteractions(thread.activities),
      tasks: presentTasks(thread.activities, thread.latestTurn?.turnId ?? null),
      toolCalls: presentToolCalls(thread.activities),
      resolvedUserInputs: presentResolvedUserInputs(thread.activities),
      messages: thread.messages.map((message) => ({
        id: message.id,
        role: message.role,
        text: message.text,
        streaming: message.streaming,
        createdAt: message.createdAt,
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
          .then((url) => vscode.env.asExternalUri(vscode.Uri.parse(url)))
          .then((uri) => this.#attachmentUrls.set(attachment.id, uri.toString(true)))
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
    #app { height: 100%; display: grid; grid-template-rows: auto 1fr auto; }
    .toolbar { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; gap: 6px; padding: 10px; border-bottom: 1px solid var(--vscode-sideBar-border); }
    .icon-button { display: inline-flex; width: 28px; height: 28px; align-items: center; justify-content: center; padding: 0; }
    .icon-button svg { display: block; }
    select { width: 100%; min-width: 0; border: 1px solid var(--vscode-dropdown-border); background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border-radius: 4px; padding: 5px 7px; }
    #status { min-height: 0; padding: 0 10px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    #status.error { color: var(--vscode-errorForeground); padding-top: 7px; padding-bottom: 7px; }
    #status:not(:empty) { padding: 0 0 6px; }
    #status:not(.error)::before { content: ''; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--vscode-descriptionForeground); vertical-align: 1px; }
    #status.working { color: var(--vscode-charts-blue); }
    #status.working::before, #status.connecting::before { background: var(--vscode-charts-blue); animation: status-pulse 1.4s ease-in-out infinite; }
    #status.completed { color: var(--vscode-charts-green); }
    #status.completed::before { background: var(--vscode-charts-green); }
    #status.needs-wake-up, #status.needs-attention { color: var(--vscode-charts-orange); }
    #status.needs-wake-up::before, #status.needs-attention::before { background: var(--vscode-charts-orange); }
    @keyframes status-pulse { 50% { opacity: .35; } }
    #messages { overflow-y: auto; padding: 12px 10px 18px; display: flex; flex-direction: column; gap: 14px; }
    .empty { margin: auto; max-width: 260px; text-align: center; color: var(--vscode-descriptionForeground); line-height: 1.5; }
    .message { min-width: 0; }
    .message.user { align-self: flex-end; max-width: 92%; border-radius: 12px 12px 3px 12px; padding: 8px 10px; background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .user-input-response { display: grid; gap: 8px; }
    .user-input-response-item { display: grid; gap: 2px; }
    .user-input-response-question { color: var(--vscode-descriptionForeground); font-size: 11px; }
    .user-input-response-answer { white-space: pre-wrap; overflow-wrap: anywhere; }
    .message.assistant, .message.system { align-self: stretch; }
    .tool-call { align-self: stretch; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .tool-call summary { display: grid; grid-template-columns: 22px auto minmax(0, 1fr) auto; align-items: center; min-height: 28px; gap: 4px; border-radius: 5px; padding: 3px 6px; cursor: pointer; list-style: none; }
    .tool-call summary::-webkit-details-marker { display: none; }
    .tool-call summary:hover { background: color-mix(in srgb, var(--vscode-descriptionForeground) 8%, transparent); }
    .tool-call-icon { display: inline-grid; width: 20px; height: 20px; place-items: center; font-family: var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); }
    .tool-call-title { overflow: hidden; color: var(--vscode-foreground); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
    .tool-call-preview { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .tool-call-state { margin-left: 4px; color: var(--vscode-charts-green); }
    .tool-call.running .tool-call-state { color: var(--vscode-charts-blue); animation: status-pulse 1.4s ease-in-out infinite; }
    .tool-call.failed .tool-call-state { color: var(--vscode-errorForeground); }
    .tool-call.stopped .tool-call-state { color: var(--vscode-charts-orange); }
    .tool-call.not-expandable summary { cursor: default; }
    .tool-call-detail { max-height: 260px; overflow: auto; margin: 3px 6px 4px 28px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 5px; padding: 8px 10px; background: var(--vscode-textCodeBlock-background); color: var(--vscode-editor-foreground); font: 11px/1.45 var(--vscode-editor-font-family); white-space: pre-wrap; overflow-wrap: anywhere; }
    .tool-changed-files { display: flex; flex-direction: column; gap: 2px; margin: 3px 6px 5px 28px; }
    .tool-changed-file { position: relative; border: 0; padding: 3px 7px 3px 20px; overflow: hidden; background: transparent; color: var(--vscode-textLink-foreground); font-family: var(--vscode-editor-font-family); font-size: 10px; text-align: left; text-overflow: ellipsis; white-space: nowrap; }
    .tool-changed-file::before { content: '±'; position: absolute; left: 6px; color: var(--vscode-descriptionForeground); }
    .tool-changed-file:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-textLink-activeForeground); }
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
    .markdown-body .inline-code-link:hover { text-decoration: none; }
    .markdown-body .inline-code-link:hover code { color: var(--vscode-textLink-activeForeground); text-decoration: underline; }
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
    #pending-interactions:empty { display: none; }
    .interaction-card { margin-bottom: 8px; border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-editorWidget-border)); border-radius: 7px; padding: 9px; background: color-mix(in srgb, var(--vscode-inputValidation-warningBackground, var(--vscode-editorWidget-background)) 55%, var(--vscode-sideBar-background)); }
    .interaction-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 5px; font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; }
    .interaction-detail, .interaction-question { margin: 5px 0 8px; line-height: 1.4; white-space: pre-wrap; overflow-wrap: anywhere; }
    .interaction-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
    .interaction-actions .allow { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    .interaction-question-group { margin: 8px 0; border: 0; padding: 0; }
    .interaction-question-group legend { margin-bottom: 5px; font-weight: 600; }
    .interaction-option { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: start; gap: 6px; margin: 4px 0; }
    .interaction-option small { display: block; color: var(--vscode-descriptionForeground); }
    .interaction-custom { width: 100%; margin-top: 5px; border: 1px solid var(--vscode-input-border); border-radius: 4px; padding: 5px 7px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    .composer { border-top: 1px solid var(--vscode-sideBar-border); padding: 8px 10px 10px; background: var(--vscode-sideBar-background); }
    #pending-attachments { display: flex; gap: 7px; overflow-x: auto; margin-bottom: 6px; }
    .pending-attachment { display: grid; grid-template-columns: 38px minmax(60px, 120px) auto; align-items: center; gap: 6px; flex: 0 0 auto; padding: 4px; border: 1px solid var(--vscode-input-border); border-radius: 6px; background: var(--vscode-input-background); }
    .pending-attachment img { width: 38px; height: 38px; border-radius: 4px; object-fit: cover; }
    .pending-attachment span { overflow: hidden; font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
    .pending-attachment button { border: 0; padding: 2px 5px; background: transparent; font-size: 16px; }
    .context { display: flex; align-items: center; gap: 6px; min-height: 28px; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .context #context { display: inline-flex; align-items: center; gap: 5px; max-width: min(26rem, calc(100% - 42px)); border: 0; border-radius: 5px; padding: 4px 7px; overflow: hidden; background: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent); color: inherit; }
    .context #context::before { content: '▱'; font-size: 14px; }
    .context #context.excluded::before { content: '◉'; opacity: .65; }
    #context-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .context-references { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
    .context-reference { max-width: 100%; border: 0; border-radius: 5px; padding: 4px 7px; overflow: hidden; background: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, transparent); color: var(--vscode-descriptionForeground); font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
    #context-window { --context-percent: 0deg; position: relative; margin-left: auto; min-width: 30px; height: 22px; padding: 0 4px; border-radius: 11px; background: conic-gradient(var(--vscode-charts-blue) var(--context-percent), color-mix(in srgb, var(--vscode-descriptionForeground) 25%, transparent) 0); color: var(--vscode-foreground); font-size: 9px; font-weight: 600; }
    #context-window::before { content: ''; position: absolute; inset: 3px; z-index: 0; border-radius: inherit; background: var(--vscode-sideBar-background); }
    #context-window-label { position: relative; z-index: 1; }
    #context-window { isolation: isolate; }
    #context-window::after { content: attr(aria-label); position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
    #context-window.critical { background: conic-gradient(var(--vscode-charts-red) var(--context-percent), color-mix(in srgb, var(--vscode-descriptionForeground) 25%, transparent) 0); }
    #context-window:not([hidden]) { display: inline-grid; place-items: center; }
    textarea { width: 100%; min-height: 72px; max-height: 220px; resize: vertical; border: 1px solid var(--vscode-input-border); border-radius: 6px; padding: 8px; outline: none; background: var(--vscode-input-background); color: var(--vscode-input-foreground); }
    textarea:focus { border-color: var(--vscode-focusBorder); }
    .prompt-wrap { position: relative; }
    #slash-commands { position: absolute; right: 0; bottom: calc(100% + 5px); left: 0; z-index: 5; overflow: hidden; border: 1px solid var(--vscode-editorWidget-border); border-radius: 7px; background: var(--vscode-editorWidget-background); box-shadow: 0 4px 18px var(--vscode-widget-shadow); }
    #slash-commands[hidden] { display: none; }
    .slash-command { display: grid; width: 100%; grid-template-columns: 74px minmax(0, 1fr); gap: 8px; border: 0; border-radius: 0; padding: 7px 9px; text-align: left; background: transparent; color: var(--vscode-foreground); }
    .slash-command:hover, .slash-command.selected { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .slash-command-name { font-family: var(--vscode-editor-font-family); font-weight: 600; }
    .slash-command-description { overflow: hidden; color: var(--vscode-descriptionForeground); text-overflow: ellipsis; white-space: nowrap; }
    .composer-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin-top: 7px; }
    .favorite-select { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto; align-items: center; }
    .favorite-toggle { border: 0; padding: 2px 3px; opacity: 0; background: transparent; color: var(--vscode-descriptionForeground); font-size: 14px; line-height: 1; transition: opacity 120ms ease; }
    .favorite-select:hover .favorite-toggle, .favorite-toggle:focus-visible { opacity: 1; }
    .favorite-toggle.active { color: var(--vscode-charts-yellow, #cca700); }
    .provider-identity { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; }
    #provider-icon { display: inline-flex; width: 17px; height: 17px; align-items: center; justify-content: center; font-size: 8px; font-weight: 700; }
    #provider-icon svg { width: 100%; height: 100%; }
    .usage-control { position: relative; }
    .tasks-control { position: relative; }
    #tasks-toggle { display: inline-flex; align-items: center; gap: 5px; border: 0; padding: 4px 6px; background: transparent; color: var(--vscode-descriptionForeground); white-space: nowrap; }
    #tasks-toggle:hover { color: var(--vscode-foreground); background: color-mix(in srgb, var(--vscode-descriptionForeground) 10%, transparent); }
    .tasks-icon { font-size: 14px; line-height: 1; }
    .tasks-details { position: fixed; z-index: 20; display: none; max-height: min(360px, calc(100vh - 24px)); overflow: auto; border: 1px solid var(--vscode-editorWidget-border); border-radius: 8px; padding: 8px; background: var(--vscode-editorWidget-background); box-shadow: 0 5px 22px var(--vscode-widget-shadow); color: var(--vscode-foreground); }
    .tasks-control:hover .tasks-details, .tasks-control:focus-within .tasks-details, .tasks-control.pinned .tasks-details { display: block; }
    .tasks-empty, .tasks-explanation { padding: 6px 7px; color: var(--vscode-descriptionForeground); font-size: 11px; line-height: 1.4; }
    .tasks-list { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
    .task-item { display: grid; grid-template-columns: 20px minmax(0, 1fr); align-items: start; gap: 5px; border-radius: 5px; padding: 6px 7px; font-size: 11px; line-height: 1.4; }
    .task-item.inProgress { background: color-mix(in srgb, var(--vscode-charts-blue) 10%, transparent); color: var(--vscode-foreground); }
    .task-item.completed { color: var(--vscode-descriptionForeground); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--vscode-descriptionForeground) 35%, transparent); }
    .task-icon { display: inline-grid; width: 18px; height: 18px; place-items: center; border: 1px solid var(--vscode-editorWidget-border); border-radius: 50%; color: var(--vscode-descriptionForeground); text-decoration: none; }
    .task-item.inProgress .task-icon { border-color: var(--vscode-charts-blue); color: var(--vscode-charts-blue); animation: status-pulse 1.4s ease-in-out infinite; }
    .task-item.completed .task-icon { border-color: color-mix(in srgb, var(--vscode-charts-green) 55%, transparent); color: var(--vscode-charts-green); }
    #usage-toggle { --usage-primary: 0deg; --usage-secondary: 0deg; position: relative; width: 35px; height: 27px; border: 0; padding: 0; background: transparent; color: var(--vscode-foreground); }
    .usage-ring { position: absolute; display: block; border-radius: 50%; }
    .usage-ring::after { content: ''; position: absolute; border-radius: inherit; background: var(--vscode-sideBar-background); }
    .usage-ring.primary { inset: 1px 5px; background: conic-gradient(var(--usage-primary-color, var(--vscode-charts-blue)) var(--usage-primary), color-mix(in srgb, var(--vscode-descriptionForeground) 22%, transparent) 0); }
    .usage-ring.primary::after { inset: 3px; }
    .usage-ring.secondary { inset: 5px 9px; z-index: 1; background: conic-gradient(var(--usage-secondary-color, var(--vscode-charts-purple, #a970ff)) var(--usage-secondary), color-mix(in srgb, var(--vscode-descriptionForeground) 22%, transparent) 0); }
    .usage-ring.secondary::after { inset: 2px; }
    #usage-label { position: relative; z-index: 2; font-size: 8px; font-weight: 600; }
    #usage-toggle.warning { --usage-primary-color: var(--vscode-charts-orange); }
    #usage-toggle.critical { --usage-primary-color: var(--vscode-charts-red); }
    .composer-actions select { border: 0; padding: 3px 18px 3px 0; color: var(--vscode-descriptionForeground); background-color: transparent; font-size: 11px; text-overflow: ellipsis; }
    #provider { max-width: 9rem; font-weight: 600; }
    #model { max-width: 14rem; }
    #provider:disabled, #model:disabled { opacity: .72; }
    #model-options { display: flex; flex: 0 1 auto; flex-wrap: nowrap; align-items: center; gap: 5px; }
    .model-option { display: flex; align-items: center; gap: 2px; min-width: 0; color: var(--vscode-descriptionForeground); font-size: 11px; }
    .model-option-icon { display: inline-grid; width: 17px; height: 17px; place-items: center; font-size: 13px; }
    .model-option select { width: auto; max-width: 7rem; border: 0; padding: 2px 14px 2px 2px; background-color: transparent; color: var(--vscode-descriptionForeground); }
    #send { margin-left: auto; }
    .usage-details { position: fixed; z-index: 10; display: none; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; padding: 8px; border: 1px solid var(--vscode-editorWidget-border); border-radius: 7px; background: var(--vscode-editorWidget-background); box-shadow: 0 4px 12px color-mix(in srgb, #000 28%, transparent); }
    .usage-control:hover .usage-details, .usage-control:focus-within .usage-details, .usage-control.pinned .usage-details { display: grid; }
    .usage-window { min-width: 0; }
    .usage-window-heading { display: flex; justify-content: space-between; gap: 5px; color: var(--vscode-descriptionForeground); font-size: 10px; }
    .usage-track { height: 3px; margin-top: 3px; overflow: hidden; border-radius: 2px; background: color-mix(in srgb, var(--vscode-descriptionForeground) 18%, transparent); }
    .usage-fill { height: 100%; border-radius: inherit; background: var(--vscode-charts-blue); }
    .usage-fill.warning { background: var(--vscode-charts-orange); }
    .usage-fill.critical { background: var(--vscode-charts-red); }
    .usage-reset { margin-top: 2px; overflow: hidden; color: var(--vscode-descriptionForeground); font-size: 9px; text-overflow: ellipsis; white-space: nowrap; }
    .usage-unavailable { color: var(--vscode-descriptionForeground); font-size: 10px; }
    #send.stop-action { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  </style>
</head>
<body>
  <div id="app">
    <div class="toolbar">
      <select id="threads" aria-label="T3 Code thread"><option>Loading threads…</option></select>
      <button id="new" class="icon-button" title="New synchronized thread" aria-label="New synchronized thread"><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M7.5 2a.5.5 0 0 1 .5.5V7h4.5a.5.5 0 0 1 0 1H8v4.5a.5.5 0 0 1-1 0V8H2.5a.5.5 0 0 1 0-1H7V2.5a.5.5 0 0 1 .5-.5Z"/></svg></button>
      <button id="refresh" title="Refresh">↻</button>
    </div>
    <main id="messages"><div class="empty">Connecting to T3 Code…</div></main>
    <div class="composer">
      <div id="status"></div>
      <div id="pending-attachments"></div>
      <div id="pending-interactions"></div>
      <div class="context"><button id="context" title="Toggle active editor context"><span id="context-label"></span></button><button id="context-window" hidden><span id="context-window-label"></span></button></div>
      <div class="prompt-wrap"><div id="slash-commands" hidden></div><textarea id="prompt" placeholder="Ask T3 Code…" aria-label="Message T3 Code"></textarea></div>
      <div class="composer-actions"><span class="provider-identity"><span id="provider-icon"></span></span><span class="favorite-select"><select id="provider" aria-label="Thread provider"><option>Select a provider</option></select><button id="favorite-provider" class="favorite-toggle" title="Add provider to favorites" aria-label="Add provider to favorites">☆</button></span><span class="favorite-select"><select id="model" aria-label="Thread model"><option>Select a model</option></select><button id="favorite-model" class="favorite-toggle" title="Add model to favorites" aria-label="Add model to favorites">☆</button></span><div id="model-options"></div><div id="tasks-control" class="tasks-control"><button id="tasks-toggle" title="Thread tasks" aria-label="Thread tasks"><span class="tasks-icon">☑</span><span id="tasks-label">Tasks</span></button><div id="tasks-details" class="tasks-details"></div></div><div id="usage-control" class="usage-control"><button id="usage-toggle" title="Provider usage" aria-label="Provider usage"><span class="usage-ring primary"></span><span class="usage-ring secondary"></span><span id="usage-label">—</span></button><div id="usage-details" class="usage-details"></div></div><button class="primary" id="send">Send</button></div>
    </div>
  </div>
  <script nonce="${scriptNonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
