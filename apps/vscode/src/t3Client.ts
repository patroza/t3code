// @effect-diagnostics globalDate:off globalFetch:off
import {
  DEFAULT_MODEL,
  DEFAULT_RUNTIME_MODE,
  type AiUsageSnapshot,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ProviderInstanceId,
  type ClientOrchestrationCommand,
  type ModelSelection,
  type OrchestrationProjectShell,
  OrchestrationShellSnapshot,
  OrchestrationThreadDetailSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadShell,
  type MessageId,
  type RuntimeMode,
  type ProviderInteractionMode,
  type ApprovalRequestId,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type ServerConfig,
  type ServerHostResourceSnapshot,
  type ThreadId,
  type UploadChatAttachment,
  type VcsStatusResult,
  WS_METHODS,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import { appendOmegentT3ProductHandshake } from "@t3tools/shared/productFamily";
import {
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "@t3tools/client-runtime/connection";
import {
  remoteHttpClientLayer,
  RpcSessionFactory,
  rpcSessionFactoryLayer,
  type RpcSession,
} from "@t3tools/client-runtime/rpc";
import { resolveRemoteWebSocketConnectionUrl } from "@t3tools/client-runtime/authorization";
import { bootstrapRemoteBearerSession } from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { applyShellStreamEvent } from "@t3tools/client-runtime/state/shell";
import { applyThreadDetailEvent } from "@t3tools/client-runtime/state/threads";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import { newCommandId, newMessageId, newProjectId, newThreadId } from "./ids.ts";

type ThreadListener = (thread: OrchestrationThread | null) => void;
type ShellListener = (shell: OrchestrationShellSnapshot) => void;
type ConnectionListener = (connected: boolean) => void;
type VcsStatusListener = (status: VcsStatusResult | null) => void;

function wsBaseUrl(httpBaseUrl: string): string {
  const url = new URL(httpBaseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function localSocketUrl(httpBaseUrl: string): string {
  const url = new URL(wsBaseUrl(httpBaseUrl));
  url.pathname = "/ws";
  url.search = "";
  url.hash = "";
  return appendOmegentT3ProductHandshake(url.toString());
}

function normalizedPath(path: string): string {
  return path.replaceAll("\\", "/").replace(/\/$/u, "").toLocaleLowerCase();
}

function messageFromCause(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  return String(cause);
}

export class T3Client {
  readonly #log: (message: string) => void;
  readonly #runtime = ManagedRuntime.make(
    Layer.merge(
      rpcSessionFactoryLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
      remoteHttpClientLayer((input, init) => globalThis.fetch(input, init)),
    ),
  );
  #scope: Scope.Closeable | null = null;
  #session: RpcSession | null = null;
  #shellFiber: Fiber.Fiber<void, unknown> | null = null;
  #threadFiber: Fiber.Fiber<void, unknown> | null = null;
  #usageFiber: Fiber.Fiber<void, unknown> | null = null;
  #vcsStatusFiber: Fiber.Fiber<void, unknown> | null = null;
  #closedFiber: Fiber.Fiber<void, never> | null = null;
  #vcsStatus: VcsStatusResult | null = null;
  #vcsStatusCwd: string | null = null;
  #shell: OrchestrationShellSnapshot | null = null;
  #activeThread: OrchestrationThread | null = null;
  #activeThreadSequence: number | null = null;
  #activeThreadId: ThreadId | null = null;
  #serverConfig: ServerConfig | null = null;
  #aiUsage: AiUsageSnapshot | null = null;
  #httpBaseUrl: string | null = null;
  #bearerToken: string | null = null;
  #connectionKey = "";
  #listeners = new Set<ThreadListener>();
  #shellListeners = new Set<ShellListener>();
  #connectionListeners = new Set<ConnectionListener>();
  #usageListeners = new Set<(snapshot: AiUsageSnapshot | null) => void>();
  #vcsStatusListeners = new Set<VcsStatusListener>();
  #shellWaiters = new Set<(snapshot: OrchestrationShellSnapshot) => void>();
  #threadWaiters = new Set<(thread: OrchestrationThread) => void>();

  constructor(log: (message: string) => void = () => {}) {
    this.#log = log;
  }

  get shell(): OrchestrationShellSnapshot | null {
    return this.#shell;
  }

  get activeThread(): OrchestrationThread | null {
    return this.#activeThread;
  }

  get serverConfig(): ServerConfig | null {
    return this.#serverConfig;
  }

  get aiUsage(): AiUsageSnapshot | null {
    return this.#aiUsage;
  }

  onThreadChanged(listener: ThreadListener): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  onShellChanged(listener: ShellListener): { dispose(): void } {
    this.#shellListeners.add(listener);
    return { dispose: () => this.#shellListeners.delete(listener) };
  }

  onConnectionChanged(listener: ConnectionListener): { dispose(): void } {
    this.#connectionListeners.add(listener);
    return { dispose: () => this.#connectionListeners.delete(listener) };
  }

  onAiUsageChanged(listener: (snapshot: AiUsageSnapshot | null) => void): { dispose(): void } {
    this.#usageListeners.add(listener);
    return { dispose: () => this.#usageListeners.delete(listener) };
  }

  /** Base URL of the connected server, for building deep links into the T3 web app. */
  get httpBaseUrl(): string | null {
    return this.#httpBaseUrl;
  }

  get vcsStatus(): VcsStatusResult | null {
    return this.#vcsStatus;
  }

  onVcsStatusChanged(listener: VcsStatusListener): { dispose(): void } {
    this.#vcsStatusListeners.add(listener);
    return { dispose: () => this.#vcsStatusListeners.delete(listener) };
  }

  /**
   * Tracks the git status of `cwd` for as long as the client lives, re-subscribing
   * across reconnects. Calling it again with the same checkout is a no-op.
   */
  watchVcsStatus(cwd: string): void {
    if (this.#vcsStatusCwd === cwd) return;
    this.#vcsStatusCwd = cwd;
    void this.#restartVcsStatusSubscription();
  }

  /**
   * Host CPU/memory/load for the environment serving this session. Returns null
   * while disconnected so callers can poll without guarding on connection state.
   */
  async hostResourceSnapshot(): Promise<ServerHostResourceSnapshot | null> {
    const session = this.#session;
    if (session === null) return null;
    return this.#runtime.runPromise(session.client[WS_METHODS.serverGetHostResourceSnapshot]({}));
  }

  async waitForShell(): Promise<OrchestrationShellSnapshot> {
    if (this.#shell !== null) return this.#shell;
    return new Promise((resolve) => this.#shellWaiters.add(resolve));
  }

  async waitForActiveThread(): Promise<OrchestrationThread> {
    if (this.#activeThread !== null) return this.#activeThread;
    return new Promise((resolve) => this.#threadWaiters.add(resolve));
  }

  async connect(httpBaseUrl: string, bearerToken?: string): Promise<void> {
    const startedAt = Date.now();
    const normalizedBaseUrl = new URL(httpBaseUrl).toString();
    const key = `${normalizedBaseUrl}|${bearerToken ?? ""}`;
    if (this.#session !== null && this.#connectionKey === key) return;
    this.#log(`connect start endpoint=${normalizedBaseUrl}`);
    await this.#closeConnection();

    let environmentId = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);
    let socketUrl = localSocketUrl(normalizedBaseUrl);
    let label = "T3 Code";
    if (bearerToken !== undefined && bearerToken !== "") {
      const descriptor = await this.#runtime.runPromise(
        fetchRemoteEnvironmentDescriptor({ httpBaseUrl: normalizedBaseUrl }),
      );
      socketUrl = await this.#runtime.runPromise(
        resolveRemoteWebSocketConnectionUrl({
          wsBaseUrl: wsBaseUrl(normalizedBaseUrl),
          httpBaseUrl: normalizedBaseUrl,
          bearerToken,
        }),
      );
      label = descriptor.label;
      environmentId = descriptor.environmentId;
    }
    const target = new PrimaryConnectionTarget({
      environmentId,
      label,
      httpBaseUrl: normalizedBaseUrl,
      wsBaseUrl: wsBaseUrl(normalizedBaseUrl),
    });
    const prepared: PreparedConnection = {
      environmentId,
      label,
      httpBaseUrl: normalizedBaseUrl,
      socketUrl,
      httpAuthorization:
        bearerToken === undefined || bearerToken === ""
          ? null
          : { _tag: "Bearer", token: bearerToken },
      target,
    };
    const scope = await this.#runtime.runPromise(Scope.make());
    try {
      const session = await this.#runtime.runPromise(
        Effect.gen(function* () {
          const factory = yield* RpcSessionFactory;
          const connected = yield* factory.connect(prepared);
          yield* connected.ready;
          return connected;
        }).pipe(Scope.provide(scope)),
      );
      this.#scope = scope;
      this.#session = session;
      this.#connectionKey = key;
      this.#serverConfig = await this.#runtime.runPromise(session.initialConfig);
      this.#log(`rpc ready in ${Date.now() - startedAt}ms endpoint=${normalizedBaseUrl}`);
      this.#httpBaseUrl = normalizedBaseUrl;
      this.#bearerToken = bearerToken ?? null;
      await this.#loadShellSnapshot(normalizedBaseUrl, bearerToken);
      this.#emitConnection(true);
      this.#startShellSubscription(session);
      this.#startUsageSubscription(session);
      if (this.#vcsStatusCwd !== null)
        this.#startVcsStatusSubscription(session, this.#vcsStatusCwd);
      if (this.#activeThreadId !== null)
        this.#startThreadSubscription(session, this.#activeThreadId);
      this.#closedFiber = this.#runtime.runFork(
        Effect.exit(session.closed).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (this.#session === session) {
                this.#session = null;
                this.#serverConfig = null;
                this.#connectionKey = "";
                this.#emitConnection(false);
              }
            }),
          ),
          Effect.asVoid,
        ),
      );
      this.#log(`connect complete in ${Date.now() - startedAt}ms endpoint=${normalizedBaseUrl}`);
    } catch (cause) {
      await this.#runtime.runPromise(Scope.close(scope, Exit.void));
      throw new Error(`Could not connect to T3 Code: ${messageFromCause(cause)}`, { cause });
    }
  }

  async connectWithBootstrap(httpBaseUrl: string, credential: string): Promise<void> {
    const baseUrl = new URL(httpBaseUrl);
    if (this.#session !== null && this.#httpBaseUrl === baseUrl.toString()) return;
    const startedAt = Date.now();
    this.#log(`bootstrap start endpoint=${baseUrl}`);
    const session = await this.#runtime.runPromise(
      bootstrapRemoteBearerSession({
        httpBaseUrl,
        credential,
        clientMetadata: { label: "T3 Code for VS Code", deviceType: "desktop" },
      }),
    );
    this.#log(`bootstrap complete in ${Date.now() - startedAt}ms endpoint=${baseUrl}`);
    await this.connect(httpBaseUrl, session.access_token);
  }

  projectsForWorktree(worktreePath: string): ReadonlyArray<OrchestrationProjectShell> {
    const shell = this.#shell;
    if (shell === null) return [];
    const target = normalizedPath(worktreePath);
    const projectIds = new Set(
      shell.threads
        .filter((thread) => {
          const project = shell.projects.find((candidate) => candidate.id === thread.projectId);
          return normalizedPath(thread.worktreePath ?? project?.workspaceRoot ?? "") === target;
        })
        .map((thread) => thread.projectId),
    );
    return shell.projects.filter(
      (project) => normalizedPath(project.workspaceRoot) === target || projectIds.has(project.id),
    );
  }

  threadsForWorktree(worktreePath: string): ReadonlyArray<OrchestrationThreadShell> {
    const shell = this.#shell;
    if (shell === null) return [];
    const target = normalizedPath(worktreePath);
    return shell.threads
      .filter((thread) => {
        const project = shell.projects.find((candidate) => candidate.id === thread.projectId);
        return normalizedPath(thread.worktreePath ?? project?.workspaceRoot ?? "") === target;
      })
      .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async selectThread(threadId: ThreadId): Promise<void> {
    const session = this.#requireSession();
    this.#activeThreadId = threadId;
    this.#activeThread = null;
    this.#activeThreadSequence = null;
    this.#emitThread();
    await this.#stopThreadSubscription();
    await this.#loadThreadSnapshot(threadId);
    this.#startThreadSubscription(session, threadId);
  }

  async createThreadForWorktree(input: {
    readonly worktreePath: string;
    readonly title: string;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly modelSelection?: ModelSelection;
  }): Promise<ThreadId> {
    const session = this.#requireSession();
    const createdAt = new Date().toISOString();
    let project = this.projectsForWorktree(input.worktreePath)[0];
    if (project === undefined) {
      const projectId = newProjectId();
      const modelSelection = input.modelSelection ?? this.#defaultModelSelection();
      await this.#dispatch({
        type: "project.create",
        commandId: newCommandId(),
        projectId,
        title: input.worktreePath.split(/[\\/]/u).at(-1) ?? "Workspace",
        workspaceRoot: input.worktreePath,
        defaultModelSelection: modelSelection,
        createdAt,
      });
      project = {
        id: projectId,
        title: input.worktreePath.split(/[\\/]/u).at(-1) ?? "Workspace",
        workspaceRoot: input.worktreePath,
        defaultModelSelection: modelSelection,
        scripts: [],
        createdAt,
        updatedAt: createdAt,
      };
    }
    const threadId = newThreadId();
    const modelSelection =
      input.modelSelection ?? project.defaultModelSelection ?? this.#defaultModelSelection();
    const isProjectRoot =
      normalizedPath(project.workspaceRoot) === normalizedPath(input.worktreePath);
    await this.#dispatch({
      type: "thread.create",
      commandId: newCommandId(),
      threadId,
      projectId: project.id,
      title: input.title,
      modelSelection,
      runtimeMode: input.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode: input.interactionMode ?? "default",
      branch: null,
      worktreePath: isProjectRoot ? null : input.worktreePath,
      createdAt,
    });
    this.#activeThreadId = threadId;
    this.#activeThread = null;
    this.#activeThreadSequence = null;
    await this.#stopThreadSubscription();
    this.#startThreadSubscription(session, threadId);
    return threadId;
  }

  async sendPrompt(input: {
    readonly threadId: ThreadId;
    readonly prompt: string;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly sourceProposedPlan?: { readonly threadId: ThreadId; readonly planId: string };
    readonly modelSelection?: ModelSelection;
    readonly attachments?: ReadonlyArray<UploadChatAttachment>;
  }): Promise<void> {
    const thread = this.#activeThread;
    const modelSelection =
      input.modelSelection ?? thread?.modelSelection ?? this.#defaultModelSelection();
    const interactionMode =
      input.interactionMode ?? thread?.interactionMode ?? ("default" as const);
    await this.#dispatch({
      type: "thread.turn.start",
      commandId: newCommandId(),
      threadId: input.threadId,
      message: {
        messageId: newMessageId(),
        role: "user",
        text: input.prompt,
        attachments: input.attachments ?? [],
      },
      modelSelection,
      titleSeed: input.prompt.trim().slice(0, 80) || "New thread",
      runtimeMode: input.runtimeMode ?? thread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode,
      ...(input.sourceProposedPlan === undefined
        ? {}
        : { sourceProposedPlan: input.sourceProposedPlan }),
      createdAt: new Date().toISOString(),
    });
  }

  async steerQueuedMessage(messageId: MessageId): Promise<void> {
    const thread = this.#activeThread;
    if (thread === null) throw new Error("Select a T3 Code thread before steering its queue.");
    await this.#dispatch({
      type: "thread.queue.steer",
      commandId: newCommandId(),
      threadId: thread.id,
      messageId,
      createdAt: new Date().toISOString(),
    });
  }

  async removeQueuedMessage(messageId: MessageId): Promise<void> {
    const thread = this.#activeThread;
    if (thread === null) throw new Error("Select a T3 Code thread before changing its queue.");
    await this.#dispatch({
      type: "thread.queue.remove",
      commandId: newCommandId(),
      threadId: thread.id,
      messageId,
      createdAt: new Date().toISOString(),
    });
  }

  async updateQueuedMessage(messageId: MessageId, text: string): Promise<void> {
    const thread = this.#activeThread;
    if (thread === null) throw new Error("Select a T3 Code thread before changing its queue.");
    await this.#dispatch({
      type: "thread.queue.update",
      commandId: newCommandId(),
      threadId: thread.id,
      messageId,
      text,
      createdAt: new Date().toISOString(),
    });
  }

  async setInteractionMode(interactionMode: ProviderInteractionMode): Promise<void> {
    const thread = this.#activeThread;
    if (thread === null)
      throw new Error("Select a T3 Code thread before changing interaction mode.");
    if (thread.interactionMode === interactionMode) return;
    await this.#dispatch({
      type: "thread.interaction-mode.set",
      commandId: newCommandId(),
      threadId: thread.id,
      interactionMode,
      createdAt: new Date().toISOString(),
    });
  }

  async setModelSelection(modelSelection: ModelSelection): Promise<void> {
    const thread = this.#activeThread;
    if (thread === null) throw new Error("Select a T3 Code thread before changing models.");
    await this.#dispatch({
      type: "thread.meta.update",
      commandId: newCommandId(),
      threadId: thread.id,
      modelSelection,
    });
  }

  async archiveThread(threadId: ThreadId): Promise<void> {
    let subscription: { dispose(): void } | undefined;
    const archived = new Promise<void>((resolve) => {
      subscription = this.onShellChanged((shell) => {
        if (!shell.threads.some((thread) => thread.id === threadId)) {
          subscription?.dispose();
          resolve();
        }
      });
    });
    try {
      await this.#dispatch({
        type: "thread.archive",
        commandId: newCommandId(),
        threadId,
      });
    } catch (cause) {
      subscription?.dispose();
      throw cause;
    }
    await archived;
    if (this.#activeThreadId === threadId) {
      await this.#stopThreadSubscription();
      this.#activeThreadId = null;
      this.#activeThread = null;
      this.#activeThreadSequence = null;
      this.#emitThread();
    }
  }

  async createAttachmentUrl(attachmentId: string): Promise<string> {
    const session = this.#requireSession();
    const httpBaseUrl = this.#httpBaseUrl;
    if (httpBaseUrl === null) throw new Error("T3 Code is not connected.");
    const result = await this.#runtime.runPromise(
      session.client[WS_METHODS.assetsCreateUrl]({
        resource: { _tag: "attachment", attachmentId },
      }),
    );
    return new URL(result.relativeUrl, httpBaseUrl).toString();
  }

  async interrupt(): Promise<void> {
    const thread = this.#activeThread;
    if (thread === null) return;
    await this.#dispatch({
      type: "thread.turn.interrupt",
      commandId: newCommandId(),
      threadId: thread.id,
      ...(thread.latestTurn?.turnId === undefined ? {} : { turnId: thread.latestTurn.turnId }),
      createdAt: new Date().toISOString(),
    });
  }

  async respondToApproval(
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const thread = this.#activeThread;
    if (thread === null) throw new Error("Select a T3 Code thread before responding.");
    await this.#dispatch({
      type: "thread.approval.respond",
      commandId: newCommandId(),
      threadId: thread.id,
      requestId,
      decision,
      createdAt: new Date().toISOString(),
    });
  }

  async respondToUserInput(
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const thread = this.#activeThread;
    if (thread === null) throw new Error("Select a T3 Code thread before responding.");
    await this.#dispatch({
      type: "thread.user-input.respond",
      commandId: newCommandId(),
      threadId: thread.id,
      requestId,
      answers,
      createdAt: new Date().toISOString(),
    });
  }

  async dispose(): Promise<void> {
    await this.#closeConnection();
    await this.#runtime.dispose();
  }

  #requireSession(): RpcSession {
    if (this.#session === null) throw new Error("T3 Code is not connected.");
    return this.#session;
  }

  #defaultModelSelection(): ModelSelection {
    const provider = this.#serverConfig?.providers.find(
      (candidate) => candidate.enabled && candidate.installed && candidate.models.length > 0,
    );
    return {
      instanceId: provider?.instanceId ?? ProviderInstanceId.make("codex"),
      model:
        provider?.models.find((model) => !model.isCustom)?.slug ??
        provider?.models[0]?.slug ??
        DEFAULT_MODEL,
    };
  }

  async #dispatch(command: ClientOrchestrationCommand): Promise<void> {
    const session = this.#requireSession();
    await this.#runtime.runPromise(
      session.client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
    );
  }

  #startShellSubscription(session: RpcSession): void {
    const stream = session.client[ORCHESTRATION_WS_METHODS.subscribeShell](
      this.#shell === null ? {} : { afterSequence: this.#shell.snapshotSequence },
    ).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          if (item.kind === "snapshot") this.#shell = item.snapshot;
          else if (item.kind === "synchronized") {
            // Status-only marker (parity with EnvironmentShellState.applyItem); no shell mutation.
          } else if (this.#shell !== null) this.#shell = applyShellStreamEvent(this.#shell, item);
          if (this.#shell !== null) {
            for (const resolve of this.#shellWaiters) resolve(this.#shell);
            this.#shellWaiters.clear();
            for (const listener of this.#shellListeners) listener(this.#shell);
          }
        }),
      ),
      Effect.tapCause((cause) => Effect.sync(() => this.#log(`shell stream failed ${cause}`))),
    );
    this.#shellFiber = this.#runtime.runFork(stream);
  }

  async #loadShellSnapshot(httpBaseUrl: string, bearerToken?: string): Promise<void> {
    const startedAt = Date.now();
    const url = new URL("/api/orchestration/shell", httpBaseUrl);
    const headers =
      bearerToken === undefined || bearerToken === ""
        ? {}
        : { authorization: `Bearer ${bearerToken}` };
    const response = await globalThis.fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Could not load T3 Code threads (HTTP ${response.status}).`);
    }
    const decode = Schema.decodeUnknownSync(Schema.fromJsonString(OrchestrationShellSnapshot));
    this.#shell = decode(await response.text());
    this.#log(
      `shell HTTP complete in ${Date.now() - startedAt}ms projects=${this.#shell.projects.length} threads=${this.#shell.threads.length} sequence=${this.#shell.snapshotSequence}`,
    );
    for (const resolve of this.#shellWaiters) resolve(this.#shell);
    this.#shellWaiters.clear();
    for (const listener of this.#shellListeners) listener(this.#shell);
  }

  #startUsageSubscription(session: RpcSession): void {
    const stream = session.client[WS_METHODS.subscribeAiUsage]({}).pipe(
      Stream.runForEach((snapshot) =>
        Effect.sync(() => {
          this.#aiUsage = snapshot;
          for (const listener of this.#usageListeners) listener(snapshot);
        }),
      ),
    );
    this.#usageFiber = this.#runtime.runFork(stream);
  }

  #startVcsStatusSubscription(session: RpcSession, cwd: string): void {
    const stream = session.client[WS_METHODS.subscribeVcsStatus]({ cwd }).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          this.#vcsStatus = applyGitStatusStreamEvent(this.#vcsStatus, event);
          this.#emitVcsStatus();
        }),
      ),
      Effect.tapCause((cause) =>
        Effect.sync(() => this.#log(`vcs status stream failed cwd=${cwd} ${cause}`)),
      ),
    );
    this.#vcsStatusFiber = this.#runtime.runFork(stream);
  }

  async #restartVcsStatusSubscription(): Promise<void> {
    await this.#stopVcsStatusSubscription();
    const session = this.#session;
    const cwd = this.#vcsStatusCwd;
    if (session === null || cwd === null) return;
    this.#startVcsStatusSubscription(session, cwd);
  }

  async #stopVcsStatusSubscription(): Promise<void> {
    if (this.#vcsStatusFiber !== null) {
      await this.#runtime.runPromise(Fiber.interrupt(this.#vcsStatusFiber));
      this.#vcsStatusFiber = null;
    }
    // A fresh subscription replays a snapshot, so the accumulated status must not
    // carry over — `applyGitStatusStreamEvent` merges partial updates into it.
    if (this.#vcsStatus !== null) {
      this.#vcsStatus = null;
      this.#emitVcsStatus();
    }
  }

  #emitVcsStatus(): void {
    for (const listener of this.#vcsStatusListeners) listener(this.#vcsStatus);
  }

  #startThreadSubscription(session: RpcSession, threadId: ThreadId): void {
    const stream = session.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
      threadId,
      ...(this.#activeThreadSequence === null ? {} : { afterSequence: this.#activeThreadSequence }),
    }).pipe(
      Stream.runForEach((item) =>
        Effect.sync(() => {
          if (item.kind === "snapshot") {
            this.#activeThread = item.snapshot.thread;
            this.#activeThreadSequence = item.snapshot.snapshotSequence;
          } else if (item.kind === "synchronized") {
            // Status-only marker (parity with EnvironmentThreadState.applyItem); no event to apply.
          } else if (this.#activeThread !== null) {
            const result = applyThreadDetailEvent(this.#activeThread, item.event);
            this.#activeThread =
              result.kind === "updated"
                ? result.thread
                : result.kind === "deleted"
                  ? null
                  : this.#activeThread;
            this.#activeThreadSequence = item.event.sequence;
          }
          if (this.#activeThread !== null) {
            for (const resolve of this.#threadWaiters) resolve(this.#activeThread);
            this.#threadWaiters.clear();
          }
          this.#emitThread();
        }),
      ),
      Effect.tapCause((cause) =>
        Effect.sync(() => this.#log(`thread stream failed id=${threadId} ${cause}`)),
      ),
    );
    this.#threadFiber = this.#runtime.runFork(stream);
  }

  async #loadThreadSnapshot(threadId: ThreadId): Promise<void> {
    const startedAt = Date.now();
    if (this.#httpBaseUrl === null) throw new Error("T3 Code is not connected.");
    const url = new URL(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
      this.#httpBaseUrl,
    );
    const headers =
      this.#bearerToken === null ? {} : { authorization: `Bearer ${this.#bearerToken}` };
    const response = await globalThis.fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Could not load the T3 Code thread (HTTP ${response.status}).`);
    }
    const decode = Schema.decodeUnknownSync(
      Schema.fromJsonString(OrchestrationThreadDetailSnapshot),
    );
    const snapshot = decode(await response.text());
    this.#activeThread = snapshot.thread;
    this.#activeThreadSequence = snapshot.snapshotSequence;
    this.#log(
      `thread HTTP complete in ${Date.now() - startedAt}ms id=${threadId} messages=${snapshot.thread.messages.length} sequence=${snapshot.snapshotSequence}`,
    );
    for (const resolve of this.#threadWaiters) resolve(this.#activeThread);
    this.#threadWaiters.clear();
    this.#emitThread();
  }

  #emitThread(): void {
    for (const listener of this.#listeners) listener(this.#activeThread);
  }

  #emitConnection(connected: boolean): void {
    for (const listener of this.#connectionListeners) listener(connected);
  }

  async #stopThreadSubscription(): Promise<void> {
    if (this.#threadFiber === null) return;
    await this.#runtime.runPromise(Fiber.interrupt(this.#threadFiber));
    this.#threadFiber = null;
  }

  async #closeConnection(): Promise<void> {
    await this.#stopThreadSubscription();
    await this.#stopVcsStatusSubscription();
    if (this.#usageFiber !== null) {
      await this.#runtime.runPromise(Fiber.interrupt(this.#usageFiber));
      this.#usageFiber = null;
    }
    this.#aiUsage = null;
    for (const listener of this.#usageListeners) listener(null);
    if (this.#closedFiber !== null) {
      await this.#runtime.runPromise(Fiber.interrupt(this.#closedFiber));
      this.#closedFiber = null;
    }
    if (this.#shellFiber !== null) {
      await this.#runtime.runPromise(Fiber.interrupt(this.#shellFiber));
      this.#shellFiber = null;
    }
    if (this.#scope !== null) {
      await this.#runtime.runPromise(Scope.close(this.#scope, Exit.void));
      this.#scope = null;
    }
    this.#session = null;
    this.#activeThread = null;
    this.#activeThreadSequence = null;
    this.#shell = null;
    this.#serverConfig = null;
    this.#httpBaseUrl = null;
    this.#bearerToken = null;
    this.#connectionKey = "";
  }
}
