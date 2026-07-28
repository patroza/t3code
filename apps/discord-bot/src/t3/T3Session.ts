// @effect-diagnostics globalDate:off globalFetch:off globalFetchInEffect:off globalTimers:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off anyUnknownInErrorContext:off missingEffectContext:off missingEffectError:off preferSchemaOverJson:off tryCatchInEffectGen:off deterministicKeys:off
import {
  ApprovalRequestId,
  DEFAULT_RUNTIME_MODE,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  ProjectId,
  WS_METHODS,
  type ClientOrchestrationCommand,
  type MessageId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationShellSnapshot,
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type OrchestrationThreadShell,
  type ProviderApprovalDecision,
  type ProviderInteractionMode,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type ServerConfig,
  type ServerProvider,
  type ThreadId,
  type UploadChatAttachment,
  type VcsResolveBranchChangeRequestResult,
  type VcsStatusStreamEvent,
} from "@t3tools/contracts";
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
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "@t3tools/client-runtime/authorization";
import { fetchRemoteEnvironmentDescriptor } from "@t3tools/client-runtime/environment";
import { applyShellStreamEvent } from "@t3tools/client-runtime/state/shell";
import { appendOmegentT3ProductHandshake } from "@t3tools/shared/productFamily";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Socket from "effect/unstable/socket/Socket";

import type { DiscordBotConfig } from "../config.ts";
import { preferredModelSelection } from "../config.ts";
import { BrowserAutomationHost } from "../browser/BrowserAutomationHost.ts";
import { formatThreadTitle } from "../presentation/messages.ts";
import { normalizeWorkspacePath } from "../presentation/mentions.ts";
import { followOrchestrationThread } from "./DiscordThreadFollower.ts";
import { newCommandId, newMessageId, newThreadId, shortId } from "./ids.ts";

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

function messageFromCause(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim() !== "") return cause.message;
  return String(cause);
}

/**
 * Detect dead/transient socket failures that should force a reconnect when
 * `RpcSession.closed` did not fire (or fired too late). Used for soft recovery
 * on dispatch errors — we do **not** auto-retry the command (double-start risk).
 */
export function isT3TransportError(cause: unknown): boolean {
  const msg = messageFromCause(cause);
  if (/SocketCloseError|ConnectionTransientError|SocketError/i.test(msg)) return true;
  if (/ECONNREFUSED|ECONNRESET|ENOTFOUND|EPIPE|ETIMEDOUT/i.test(msg)) return true;
  if (/websocket/i.test(msg) && /close|closed|reset|refused|not connected/i.test(msg)) return true;
  return false;
}

/** User-facing copy when the bot is online but T3 is still (re)connecting. */
export const T3_STILL_CONNECTING_MESSAGE =
  "T3 is still connecting after a server restart (or first boot). Try again in a few seconds.";

export function shouldPersistThreadModelSelectionForNextTurn(input: {
  readonly currentModelSelection?: ModelSelection;
  readonly nextModelSelection?: ModelSelection;
}): boolean {
  const next = input.nextModelSelection;
  if (next === undefined) return false;
  const current = input.currentModelSelection;
  if (current === undefined) return true;
  return (
    next.model !== current.model ||
    next.instanceId !== current.instanceId ||
    JSON.stringify(next.options ?? null) !== JSON.stringify(current.options ?? null)
  );
}

export class T3SessionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "T3SessionError";
  }
}

export interface T3SessionService {
  readonly connect: () => Effect.Effect<void, T3SessionError>;
  /**
   * Keep retrying {@link connect} with the same backoff as mid-life reconnect
   * until the shell snapshot is live. Used at boot so the process does not exit
   * when Discord comes up before T3 (guest restart race).
   */
  readonly connectUntilReady: () => Effect.Effect<void>;
  /**
   * Register a callback invoked after a successful automatic reconnect
   * (socket drop → reconnectLoop). Used to rehydrate Discord bridges.
   */
  readonly setOnReconnected: (handler: (() => Promise<void>) | null) => void;
  /**
   * True when a live RpcSession exists (may still be waiting for shell on a
   * race; prefer {@link isReady} before project lookups).
   */
  readonly isConnected: () => Effect.Effect<boolean>;
  /** True when connected and the orchestration shell snapshot has arrived. */
  readonly isReady: () => Effect.Effect<boolean>;
  readonly shell: () => Effect.Effect<OrchestrationShellSnapshot | null>;
  readonly serverConfig: () => Effect.Effect<ServerConfig | null>;
  readonly findProjectByWorkspaceRoot: (
    workspaceRoot: string,
  ) => Effect.Effect<OrchestrationProjectShell | null>;
  readonly getProjectShell: (
    projectId: ProjectId,
  ) => Effect.Effect<OrchestrationProjectShell | null>;
  readonly startTurnWithWorktree: (input: {
    readonly project: OrchestrationProjectShell;
    readonly prompt: string;
    readonly titleSeed?: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly baseBranch: string;
    readonly local: boolean;
    /** User images from Discord (same shape as web composer uploads). */
    readonly attachments?: ReadonlyArray<UploadChatAttachment>;
  }) => Effect.Effect<{ readonly threadId: ThreadId; readonly messageId: string }, T3SessionError>;
  readonly startTurn: (input: {
    readonly threadId: ThreadId;
    readonly prompt: string;
    readonly messageId?: MessageId;
    readonly modelSelection?: ModelSelection;
    readonly runtimeMode?: RuntimeMode;
    readonly interactionMode?: ProviderInteractionMode;
    readonly attachments?: ReadonlyArray<UploadChatAttachment>;
  }) => Effect.Effect<{ readonly messageId: string }, T3SessionError>;
  /**
   * Inject a server-queued follow-up into the active turn (or start a turn if
   * idle). Used after `startTurn` queues a mid-turn Discord message so the bot
   * keeps historical steer-by-default behavior.
   */
  readonly steerQueuedMessage: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<void, T3SessionError>;
  readonly removeQueuedMessage: (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
  }) => Effect.Effect<void, T3SessionError>;
  /**
   * Subscribe to thread events until disconnect/interrupt.
   * Runs `onThread` in the caller fiber context (must not be forked onto a bare T3 runtime).
   *
   * @param options.afterSequence - when set, only events after this sequence are streamed
   *   (no embedded snapshot unless warmSeed is missing). Prefer warm seed or HTTP tip first.
   * @param options.onSequence - durable marker callback after each applied snapshot/event.
   * @param options.warmSeed - durable trimmed tip (web/desktop-style cache). When set with a
   *   finite sequence, skips HTTP full-tip fetch and resumes via afterSequence from that base.
   * @param options.projectThread - optional projection before onThread / retained apply base
   *   (e.g. drop Discord-finalized history beyond a small buffer).
   */
  readonly subscribeThread: (
    threadId: ThreadId,
    onThread: (thread: OrchestrationThread) => Effect.Effect<void, unknown, unknown>,
    options?: {
      readonly afterSequence?: number;
      readonly onSequence?: (sequence: number) => Effect.Effect<void, unknown, unknown>;
      readonly warmSeed?: {
        readonly snapshotSequence: number;
        readonly thread: OrchestrationThread;
      } | null;
      readonly projectThread?: (thread: OrchestrationThread) => OrchestrationThread;
    },
  ) => Effect.Effect<void, T3SessionError, unknown>;
  readonly respondToApproval: (
    threadId: ThreadId,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, T3SessionError>;
  readonly respondToUserInput: (
    threadId: ThreadId,
    requestId: string,
    answers: ProviderUserInputAnswers,
  ) => Effect.Effect<void, T3SessionError>;
  readonly interrupt: (threadId: ThreadId) => Effect.Effect<void, T3SessionError>;
  readonly resolveModelSelection: (input: {
    readonly project?: OrchestrationProjectShell | null;
    readonly stickyModelSelection?: ModelSelection | null;
    readonly overrideInstanceId?: string;
    readonly overrideModel?: string;
  }) => Effect.Effect<ModelSelection>;
  readonly getThreadShell: (threadId: ThreadId) => Effect.Effect<OrchestrationThreadShell | null>;
  /**
   * HTTP snapshot of a thread (full transcript + sequence). Used by Discord bridges to
   * reconcile when the WS event stream stalls mid-turn so Discord is not stuck on Working..
   * while the T3 client still shows progress.
   */
  readonly fetchThreadDetail: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationThreadDetailSnapshot | null, T3SessionError>;
  readonly resolveBranchChangeRequest: (input: {
    readonly cwd: string;
    readonly refName: string;
  }) => Effect.Effect<VcsResolveBranchChangeRequestResult, T3SessionError>;
  readonly subscribeVcsStatus: (
    cwd: string,
    onStatus: (event: VcsStatusStreamEvent) => Effect.Effect<void, unknown, unknown>,
  ) => Effect.Effect<void, T3SessionError, unknown>;
  readonly refreshVcsStatus: (cwd: string) => Effect.Effect<void, T3SessionError>;
  /**
   * Resolve a signed absolute HTTP URL for a chat attachment (image) stored on the T3 server.
   * Used so Discord can download and re-upload the file as a message attachment.
   */
  readonly createAttachmentUrl: (attachmentId: string) => Effect.Effect<string, T3SessionError>;
  /**
   * Resolve a signed absolute HTTP URL for a workspace (or absolute host) file via assets.createUrl.
   * Used for Codex `generated_images` paths that appear as markdown embeds, when local disk
   * is not readable from the bot process.
   */
  readonly createWorkspaceFileUrl: (input: {
    readonly threadId: ThreadId;
    readonly path: string;
  }) => Effect.Effect<string, T3SessionError>;
}

export class T3Session extends Context.Service<T3Session, T3SessionService>()(
  "@t3tools/discord-bot/t3/T3Session",
) {}

/**
 * Same backoff as EnvironmentSupervisor (client-runtime connection/supervisor.ts), so
 * the bot behaves like the web and mobile clients rather than inventing its own policy.
 */
const RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;

/** How long to wait for the first shell snapshot after the WS is up (ms poll × attempts). */
const SHELL_SNAPSHOT_POLL_MS = 100;
const SHELL_SNAPSHOT_MAX_ATTEMPTS = 150; // 15s — guest T3 can lag Discord on restart

/** Brief wait for shell when a mention races reconnect completion. */
const PROJECT_LOOKUP_SHELL_WAIT_ATTEMPTS = 30; // 3s

export const makeT3Session = (botConfig: DiscordBotConfig) =>
  Effect.sync(() => {
    const runtime = ManagedRuntime.make(
      Layer.merge(
        rpcSessionFactoryLayer.pipe(Layer.provide(Socket.layerWebSocketConstructorGlobal)),
        remoteHttpClientLayer((input, init) => globalThis.fetch(input, init)),
      ),
    );

    let scope: Scope.Closeable | null = null;
    let session: RpcSession | null = null;
    let httpBaseUrl: string | null = null;
    /** Bearer used for HTTP snapshot reloads (same token as WS connect). */
    let httpBearerToken: string | null = null;
    let shell: OrchestrationShellSnapshot | null = null;
    let serverConfig: ServerConfig | null = null;
    let shellFiber: Fiber.Fiber<void, unknown> | null = null;
    let browserFiber: Fiber.Fiber<void, unknown> | null = null;
    let browserHost: BrowserAutomationHost | null = null;
    let reconnecting = false;
    let onReconnected: (() => Promise<void>) | null = null;
    const threadFibers = new Map<string, Fiber.Fiber<void, unknown>>();

    const requireSession = (): RpcSession => {
      if (session === null) throw new T3SessionError(T3_STILL_CONNECTING_MESSAGE);
      return session;
    };

    /**
     * Tear the connection down so the next connect() rebuilds it.
     *
     * Without this the bot keeps a dead socket forever: connectPrepared() early-returns
     * while `session` is non-null, so every dispatch after a server restart failed with
     * `SocketCloseError: 1005` until the bot was manually restarted.
     */
    const teardown = async () => {
      const previousScope = scope;
      const previousFibers = [shellFiber, browserFiber, ...threadFibers.values()];
      const previousBrowserHost = browserHost;
      scope = null;
      session = null;
      httpBaseUrl = null;
      httpBearerToken = null;
      shell = null;
      serverConfig = null;
      shellFiber = null;
      browserFiber = null;
      browserHost = null;
      // Drop thread subscriptions so subscribeThread() re-subscribes on the new session
      // instead of holding fibers that will never emit again.
      threadFibers.clear();

      // These are forked on the ManagedRuntime, not on the connection scope, so closing
      // the scope does NOT stop them -- they would sit on a dead socket forever.
      // Interrupt explicitly, matching subscribeThread's existing replace-fiber pattern.
      for (const fiber of previousFibers) {
        if (fiber !== null) {
          await runtime.runPromise(Fiber.interrupt(fiber)).catch(() => {});
        }
      }
      if (previousScope !== null) {
        await runtime.runPromise(Scope.close(previousScope, Exit.void)).catch(() => {});
      }
      if (previousBrowserHost !== null) {
        await previousBrowserHost.close().catch(() => {});
      }
    };

    /**
     * When the socket is dead but `closed` never fired (or dispatch saw the failure
     * first), tear down and enter reconnectLoop. Does not re-run the failed command.
     */
    const scheduleReconnectFromTransportError = (cause: unknown) => {
      if (reconnecting) return;
      void (async () => {
        await runtime
          .runPromise(
            Effect.logWarning(`T3 transport error; forcing reconnect: ${messageFromCause(cause)}`),
          )
          .catch(() => {});
        await teardown();
        await reconnectLoop();
      })();
    };

    /**
     * Reconnect with backoff, mirroring EnvironmentSupervisor's schedule
     * (packages/client-runtime/src/connection/supervisor.ts) which web/mobile already
     * use. Retries indefinitely: a server restart is routine here, and the bot has
     * nothing useful to do while disconnected.
     */
    const reconnectLoop = async () => {
      if (reconnecting) return;
      reconnecting = true;
      try {
        for (let attempt = 0; ; attempt += 1) {
          const delay =
            RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 16_000;
          await runtime.runPromise(Effect.sleep(Duration.millis(delay))).catch(() => {});
          try {
            await runtime.runPromise(connect());
            await runtime.runPromise(Effect.logInfo("Reconnected to T3"));
            const handler = onReconnected;
            if (handler !== null) {
              try {
                await handler();
              } catch (cause) {
                await runtime
                  .runPromise(
                    Effect.logError(`T3 reconnect rehydrate failed: ${messageFromCause(cause)}`),
                  )
                  .catch(() => {});
              }
            }
            return;
          } catch (cause) {
            await runtime
              .runPromise(
                Effect.logWarning(
                  `T3 reconnect attempt ${attempt + 1} failed: ${messageFromCause(cause)}`,
                ),
              )
              .catch(() => {});
          }
        }
      } finally {
        reconnecting = false;
      }
    };

    /**
     * `RpcSession.closed` fails with ConnectionTransientError when the socket drops.
     * Watching it means we notice a server restart immediately, instead of discovering
     * it on the next user-visible dispatch and reporting a raw socket error to Discord.
     */
    // Not stored: this fiber ends when `closed` fires, and it is the thing that calls
    // teardown() -- holding a handle would only tempt us into interrupting it from
    // inside itself.
    const superviseClose = (connected: RpcSession) => {
      runtime.runFork(
        connected.closed.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              // Another fiber may already have torn down and started reconnect
              // (e.g. soft recovery from a transport error on dispatch).
              if (session !== connected) return;
              yield* Effect.logWarning(`T3 connection lost: ${messageFromCause(cause)}`);
              yield* Effect.promise(() => teardown());
              yield* Effect.promise(() => reconnectLoop());
            }),
          ),
          Effect.asVoid,
        ),
      );
    };

    const nowIso = () => DateTime.formatIso(DateTime.nowUnsafe());

    const dispatch = (command: ClientOrchestrationCommand) =>
      Effect.tryPromise({
        try: () =>
          runtime.runPromise(
            requireSession().client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
          ),
        catch: (cause) => {
          if (isT3TransportError(cause)) {
            scheduleReconnectFromTransportError(cause);
          }
          return new T3SessionError(`dispatch failed: ${messageFromCause(cause)}`, { cause });
        },
      }).pipe(Effect.asVoid);

    const claimBrowserHost = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const claim = browserHost?.claim(threadId);
        if (claim === null || claim === undefined) return;
        yield* requireSession().client[WS_METHODS.previewAutomationFocusHost](claim);
        yield* Effect.logInfo("Claimed Discord browser host for thread", { threadId });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not claim Discord browser host for thread", {
            threadId,
            cause,
          }),
        ),
      );

    // Parameter must not be named `httpBaseUrl` — that shadows the outer
    // connection-state binding, so `httpBaseUrl = normalizedBaseUrl` would only
    // mutate the parameter and leave outer state null forever. steernow and
    // bridge HTTP reseed then always see "snapshot unavailable".
    const connectPrepared = (baseUrl: string, bearerToken?: string) =>
      Effect.tryPromise({
        try: async () => {
          const normalizedBaseUrl = new URL(baseUrl).toString();
          // Half-open: session without shell must never short-circuit (stuck forever).
          if (session !== null && shell !== null) return;
          if (session !== null && shell === null) {
            await teardown();
          }

          let environmentId = EnvironmentId.make(PRIMARY_LOCAL_ENVIRONMENT_ID);
          let socketUrl = localSocketUrl(normalizedBaseUrl);
          let label = "T3 Code";
          if (bearerToken !== undefined && bearerToken !== "") {
            const descriptor = await runtime.runPromise(
              fetchRemoteEnvironmentDescriptor({ httpBaseUrl: normalizedBaseUrl }),
            );
            socketUrl = await runtime.runPromise(
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

          const nextScope = await runtime.runPromise(Scope.make());
          try {
            const connected = await runtime.runPromise(
              Effect.gen(function* () {
                const factory = yield* RpcSessionFactory;
                const result = yield* factory.connect(prepared);
                yield* result.ready;
                return result;
              }).pipe(Scope.provide(nextScope)),
            );
            scope = nextScope;
            session = connected;
            httpBaseUrl = normalizedBaseUrl;
            httpBearerToken = bearerToken !== undefined && bearerToken !== "" ? bearerToken : null;
            serverConfig = await runtime.runPromise(connected.initialConfig);
            superviseClose(connected);

            const stream = connected.client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
              Stream.runForEach((item) =>
                Effect.sync(() => {
                  if (item.kind === "snapshot") shell = item.snapshot;
                  else if (item.kind === "synchronized") {
                    // Status-only marker (parity with EnvironmentShellState.applyItem);
                    // no shell snapshot mutation in the headless bridge.
                  } else if (shell !== null) shell = applyShellStreamEvent(shell, item);
                }),
              ),
            );
            shellFiber = runtime.runFork(stream);

            if (botConfig.browserEnabled) {
              try {
                const host = await BrowserAutomationHost.launch(botConfig, environmentId);
                browserHost = host;
                browserFiber = runtime.runFork(
                  connected.client[WS_METHODS.previewAutomationConnect](host.registration()).pipe(
                    Stream.runForEach((event) =>
                      Effect.gen(function* () {
                        const startedAt = yield* Clock.currentTimeMillis;
                        const response = yield* Effect.tryPromise({
                          try: () => host.consume(event),
                          catch: (cause) =>
                            new T3SessionError(
                              `Browser operation failed: ${messageFromCause(cause)}`,
                              { cause },
                            ),
                        });
                        if (event.type === "request") {
                          yield* Effect.logInfo("Discord browser operation completed", {
                            operation: event.request.operation,
                            requestId: event.request.requestId,
                            tabId: event.request.tabId ?? null,
                            elapsedMs: (yield* Clock.currentTimeMillis) - startedAt,
                            ok: response?.ok ?? false,
                            errorTag: response?.error?._tag ?? null,
                          });
                        }
                        return response;
                      }).pipe(
                        Effect.flatMap((response) =>
                          response === null
                            ? Effect.void
                            : connected.client[WS_METHODS.previewAutomationRespond](response),
                        ),
                      ),
                    ),
                    Effect.catchCause((cause) =>
                      Effect.sync(() => {
                        if (browserHost === host) browserHost = null;
                      }).pipe(
                        Effect.andThen(Effect.promise(() => host.close())),
                        Effect.ignore,
                        Effect.andThen(
                          Effect.logError(
                            `Discord browser automation host stopped: ${messageFromCause(cause)}`,
                          ),
                        ),
                      ),
                    ),
                    Effect.asVoid,
                  ),
                );
                await runtime.runPromise(
                  Effect.logInfo("Discord browser automation host active", {
                    profile: botConfig.browserProfile,
                  }),
                );
              } catch (cause) {
                await runtime.runPromise(
                  Effect.logError(
                    `Discord browser automation unavailable: ${messageFromCause(cause)}`,
                  ),
                );
              }
            }

            // `shell` is updated by the concurrently running subscription fiber.
            for (let attempt = 0; attempt < SHELL_SNAPSHOT_MAX_ATTEMPTS; attempt += 1) {
              // eslint-disable-next-line no-unmodified-loop-condition -- shell is set by shellFiber
              if (shell !== null) break;
              await Effect.runPromise(Effect.sleep(Duration.millis(SHELL_SNAPSHOT_POLL_MS)));
            }
            if (shell === null) {
              throw new T3SessionError(
                "Connected to T3 but the orchestration shell snapshot did not arrive in time",
              );
            }
          } catch (cause) {
            // Full teardown is required: a partial connect leaves session non-null and
            // the next connectPrepared early-returns forever (stuck bot after restart).
            await teardown();
            // nextScope may not have been published to `scope` yet (fail before assign).
            await runtime.runPromise(Scope.close(nextScope, Exit.void)).catch(() => {});
            throw cause instanceof T3SessionError
              ? cause
              : new T3SessionError(`Could not connect to T3 Code: ${messageFromCause(cause)}`, {
                  cause,
                });
          }
        },
        catch: (cause) =>
          cause instanceof T3SessionError
            ? cause
            : new T3SessionError(messageFromCause(cause), { cause }),
      });

    const connect = () =>
      Effect.gen(function* () {
        if (botConfig.t3BearerToken !== undefined && botConfig.t3BearerToken !== "") {
          yield* connectPrepared(botConfig.t3HttpBaseUrl, botConfig.t3BearerToken);
          return;
        }
        if (
          botConfig.t3BootstrapCredential !== undefined &&
          botConfig.t3BootstrapCredential !== ""
        ) {
          const tokenSession = yield* Effect.tryPromise({
            try: () =>
              runtime.runPromise(
                bootstrapRemoteBearerSession({
                  httpBaseUrl: botConfig.t3HttpBaseUrl,
                  credential: botConfig.t3BootstrapCredential!,
                  clientMetadata: { label: "T3 Discord Bot", deviceType: "bot" },
                }),
              ),
            catch: (cause) =>
              new T3SessionError(`Bootstrap failed: ${messageFromCause(cause)}`, { cause }),
          });
          yield* connectPrepared(botConfig.t3HttpBaseUrl, tokenSession.access_token);
          return;
        }
        yield* connectPrepared(botConfig.t3HttpBaseUrl);
      });

    /**
     * Boot path: Discord may start before guest T3 is listening. Retry forever
     * with the same schedule as mid-life reconnect instead of exiting the process.
     */
    const connectUntilReady = () =>
      Effect.gen(function* () {
        for (let attempt = 0; ; attempt += 1) {
          const outcome = yield* Effect.result(connect());
          if (Result.isSuccess(outcome)) return;
          const delay =
            RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)] ?? 16_000;
          yield* Effect.logWarning(
            `T3 boot connect attempt ${attempt + 1} failed: ${messageFromCause(outcome.failure)}; retrying in ${delay}ms`,
          );
          yield* Effect.sleep(Duration.millis(delay));
        }
      });

    const providersForSelection = (): ReadonlyArray<ServerProvider> =>
      serverConfig?.providers ?? [];

    const fetchThreadDetailHttp = (threadId: ThreadId) =>
      Effect.tryPromise({
        try: async (): Promise<OrchestrationThreadDetailSnapshot | null> => {
          const base = httpBaseUrl;
          if (base === null) return null;
          const url = new URL(
            `/api/orchestration/threads/${encodeURIComponent(threadId)}`,
            base,
          ).toString();
          const headers: Record<string, string> = { Accept: "application/json" };
          if (httpBearerToken !== null) {
            headers.Authorization = `Bearer ${httpBearerToken}`;
          }
          const response = await globalThis.fetch(url, { headers });
          if (!response.ok) {
            throw new Error(`HTTP ${response.status} loading thread snapshot`);
          }
          return (await response.json()) as OrchestrationThreadDetailSnapshot;
        },
        catch: (cause) =>
          new T3SessionError(`Thread snapshot fetch failed: ${messageFromCause(cause)}`, {
            cause,
          }),
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not fetch thread snapshot over HTTP", {
            threadId,
            error: String(error),
          }).pipe(Effect.as(null)),
        ),
      );

    return T3Session.of({
      connect,
      connectUntilReady,
      setOnReconnected: (handler) => {
        onReconnected = handler;
      },
      isConnected: () => Effect.sync(() => session !== null),
      isReady: () => Effect.sync(() => session !== null && shell !== null),
      shell: () => Effect.succeed(shell),
      serverConfig: () => Effect.succeed(serverConfig),
      findProjectByWorkspaceRoot: (workspaceRoot) =>
        Effect.gen(function* () {
          // Mentions can land while shell is still filling after reconnect.
          for (let attempt = 0; attempt < PROJECT_LOOKUP_SHELL_WAIT_ATTEMPTS; attempt += 1) {
            // shell/session are mutated by connect/teardown/shellFiber, not this loop body.
            if (shell !== null || session === null) break;
            yield* Effect.sleep(Duration.millis(SHELL_SNAPSHOT_POLL_MS));
          }
          if (shell === null) return null;
          const target = normalizeWorkspacePath(workspaceRoot);
          return (
            shell.projects.find(
              (project) => normalizeWorkspacePath(project.workspaceRoot) === target,
            ) ?? null
          );
        }),
      getProjectShell: (projectId) =>
        Effect.sync(() => shell?.projects.find((project) => project.id === projectId) ?? null),
      resolveModelSelection: ({
        project,
        stickyModelSelection,
        overrideInstanceId,
        overrideModel,
      }) =>
        Effect.sync(() =>
          preferredModelSelection({
            config: botConfig,
            providers: providersForSelection(),
            projectDefault: project?.defaultModelSelection ?? null,
            ...(stickyModelSelection === undefined ? {} : { stickyModelSelection }),
            ...(overrideInstanceId === undefined ? {} : { overrideInstanceId }),
            ...(overrideModel === undefined ? {} : { overrideModel }),
          }),
        ),
      getThreadShell: (threadId) =>
        Effect.sync(() => shell?.threads.find((thread) => thread.id === threadId) ?? null),
      fetchThreadDetail: (threadId) => fetchThreadDetailHttp(threadId),
      resolveBranchChangeRequest: (input) =>
        Effect.tryPromise({
          try: () =>
            runtime.runPromise(
              requireSession().client[WS_METHODS.vcsResolveBranchChangeRequest](input),
            ),
          catch: (cause) =>
            new T3SessionError(
              `Could not resolve branch change request for ${input.refName}: ${messageFromCause(cause)}`,
              { cause },
            ),
        }),
      startTurnWithWorktree: (input) =>
        Effect.gen(function* () {
          const threadId = newThreadId();
          const messageId = newMessageId();
          const createdAt = nowIso();
          const title = formatThreadTitle(input.titleSeed ?? input.prompt, 72, "Discord thread");
          const interactionMode = input.interactionMode ?? "default";
          const runtimeMode = input.runtimeMode ?? botConfig.t3DefaultRuntimeMode;
          const worktreeBranch = `t3-discord/${shortId()}`;

          yield* claimBrowserHost(threadId);
          yield* dispatch({
            type: "thread.turn.start",
            commandId: newCommandId(),
            threadId,
            message: {
              messageId,
              role: "user",
              text: input.prompt,
              attachments: (input.attachments ?? []) as ReadonlyArray<UploadChatAttachment>,
            },
            modelSelection: input.modelSelection,
            titleSeed: title,
            runtimeMode,
            interactionMode,
            bootstrap: {
              createThread: {
                projectId: input.project.id,
                title,
                modelSelection: input.modelSelection,
                runtimeMode,
                interactionMode,
                branch: null,
                worktreePath: null,
                createdAt,
              },
              ...(input.local
                ? {}
                : {
                    prepareWorktree: {
                      projectCwd: input.project.workspaceRoot,
                      baseBranch: input.baseBranch,
                      branch: worktreeBranch,
                      startFromOrigin: true,
                    },
                    runSetupScript: true,
                  }),
            },
            createdAt,
          });

          return { threadId, messageId };
        }),
      startTurn: (input) =>
        Effect.gen(function* () {
          const thread = shell?.threads.find((entry) => entry.id === input.threadId);
          const messageId = input.messageId ?? newMessageId();
          // Sticky model on continue: never re-apply bot defaults (codex/gpt-5.4).
          // Explicit overrides come only from Discord --provider/--model flags.
          // modelSelection is optional on thread.turn.start; omit when unknown so the
          // server keeps the thread's existing selection (Grok refuses mid-thread switches).
          const modelSelection = input.modelSelection ?? thread?.modelSelection;
          yield* claimBrowserHost(input.threadId);
          if (
            shouldPersistThreadModelSelectionForNextTurn({
              ...(thread?.modelSelection === undefined
                ? {}
                : { currentModelSelection: thread.modelSelection }),
              ...(modelSelection === undefined ? {} : { nextModelSelection: modelSelection }),
            })
          ) {
            yield* dispatch({
              type: "thread.meta.update",
              commandId: newCommandId(),
              threadId: input.threadId,
              modelSelection,
            });
          }
          yield* dispatch({
            type: "thread.turn.start",
            commandId: newCommandId(),
            threadId: input.threadId,
            message: {
              messageId,
              role: "user",
              text: input.prompt,
              attachments: (input.attachments ?? []) as ReadonlyArray<UploadChatAttachment>,
            },
            ...(modelSelection === undefined ? {} : { modelSelection }),
            titleSeed: input.prompt.trim().slice(0, 80) || "Continue",
            runtimeMode: input.runtimeMode ?? thread?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
            interactionMode: input.interactionMode ?? thread?.interactionMode ?? "default",
            createdAt: nowIso(),
          });
          return { messageId };
        }),
      steerQueuedMessage: (input) =>
        dispatch({
          type: "thread.queue.steer",
          commandId: newCommandId(),
          threadId: input.threadId,
          messageId: input.messageId,
          createdAt: nowIso(),
        }),
      removeQueuedMessage: (input) =>
        dispatch({
          type: "thread.queue.remove",
          commandId: newCommandId(),
          threadId: input.threadId,
          messageId: input.messageId,
          createdAt: nowIso(),
        }),
      /**
       * Subscribe to thread events and run `onThread` in the **caller's** Effect context.
       *
       * Must NOT use `runtime.runFork` — that runs on the T3 ManagedRuntime without
       * DiscordREST, so every Discord post fails silently ("nothing happens").
       * Run the stream with `yield*` so the Discord bridge fiber provides services.
       *
       * Client-aligned via {@link followOrchestrationThread} (same apply/reload/retry
       * semantics as EnvironmentThreadState; no core package edits).
       */
      subscribeThread: (threadId, onThread, options) =>
        Effect.gen(function* () {
          const active = requireSession();
          yield* followOrchestrationThread({
            threadId,
            afterSequence: options?.afterSequence ?? null,
            ...(options?.onSequence !== undefined ? { onSequence: options.onSequence } : {}),
            warmSeed: options?.warmSeed ?? null,
            ...(options?.projectThread !== undefined
              ? { projectThread: options.projectThread }
              : {}),
            onThread,
            fetchSnapshot: () => fetchThreadDetailHttp(threadId),
            openStream: ({ afterSequence }) =>
              active.client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                threadId,
                ...(afterSequence !== undefined ? { afterSequence } : {}),
              }).pipe(
                Stream.mapError(
                  (cause) =>
                    new T3SessionError(`Thread subscription failed: ${messageFromCause(cause)}`, {
                      cause,
                    }),
                ),
              ),
            retryForever: true,
          });
        }),
      subscribeVcsStatus: (cwd, onStatus) =>
        Effect.gen(function* () {
          const active = requireSession();

          yield* active.client[WS_METHODS.subscribeVcsStatus]({
            cwd,
          }).pipe(
            Stream.runForEach((event) =>
              onStatus(event).pipe(
                Effect.catchCause((cause) =>
                  Effect.logError("Thread bridge onVcsStatus failed", { cwd, cause }),
                ),
              ),
            ),
            Effect.mapError(
              (cause) =>
                new T3SessionError(`VCS status subscription failed: ${messageFromCause(cause)}`, {
                  cause,
                }),
            ),
          );
        }),
      refreshVcsStatus: (cwd) =>
        Effect.tryPromise({
          try: () =>
            runtime.runPromise(
              requireSession().client[WS_METHODS.vcsRefreshStatus]({
                cwd,
              }),
            ),
          catch: (cause) =>
            new T3SessionError(
              `Could not refresh VCS status for ${cwd}: ${messageFromCause(cause)}`,
              {
                cause,
              },
            ),
        }).pipe(Effect.asVoid),
      respondToApproval: (threadId, requestId, decision) =>
        dispatch({
          type: "thread.approval.respond",
          commandId: newCommandId(),
          threadId,
          requestId: ApprovalRequestId.make(requestId),
          decision,
          createdAt: nowIso(),
        }),
      respondToUserInput: (threadId, requestId, answers) =>
        dispatch({
          type: "thread.user-input.respond",
          commandId: newCommandId(),
          threadId,
          requestId: ApprovalRequestId.make(requestId),
          answers,
          createdAt: nowIso(),
        }),
      interrupt: (threadId) =>
        Effect.gen(function* () {
          const threadShell = shell?.threads.find((entry) => entry.id === threadId);
          yield* dispatch({
            type: "thread.turn.interrupt",
            commandId: newCommandId(),
            threadId,
            ...(threadShell?.latestTurn?.turnId === undefined
              ? {}
              : { turnId: threadShell.latestTurn.turnId }),
            createdAt: nowIso(),
          });
        }),
      createAttachmentUrl: (attachmentId) =>
        Effect.tryPromise({
          try: async () => {
            const active = requireSession();
            const base = httpBaseUrl;
            if (base === null) {
              throw new T3SessionError("T3 Code is not connected.");
            }
            const result = await runtime.runPromise(
              active.client[WS_METHODS.assetsCreateUrl]({
                resource: { _tag: "attachment", attachmentId },
              }),
            );
            return new URL(result.relativeUrl, base).toString();
          },
          catch: (cause) =>
            cause instanceof T3SessionError
              ? cause
              : new T3SessionError(
                  `Could not create attachment URL for ${attachmentId}: ${messageFromCause(cause)}`,
                  { cause },
                ),
        }),
      createWorkspaceFileUrl: ({ threadId, path }) =>
        Effect.tryPromise({
          try: async () => {
            const active = requireSession();
            const base = httpBaseUrl;
            if (base === null) {
              throw new T3SessionError("T3 Code is not connected.");
            }
            const result = await runtime.runPromise(
              active.client[WS_METHODS.assetsCreateUrl]({
                resource: { _tag: "workspace-file", threadId, path },
              }),
            );
            return new URL(result.relativeUrl, base).toString();
          },
          catch: (cause) =>
            cause instanceof T3SessionError
              ? cause
              : new T3SessionError(
                  `Could not create workspace file URL for ${path}: ${messageFromCause(cause)}`,
                  { cause },
                ),
        }),
    });
  });

export const layer = (botConfig: DiscordBotConfig) =>
  Layer.effect(T3Session, makeT3Session(botConfig));
