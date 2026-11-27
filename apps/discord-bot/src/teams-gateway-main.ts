// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalPromise:off missingEffectContext:off anyUnknownInErrorContext:off unsafeEffectTypeAssertion:off layerMergeAllWithDependencies:off effectTryWithoutCatch:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ApiClient } from "@microsoft/teams.apps/dist/api.js";
import {
  makeTeamsChannelDescriptionReader,
  teamsDescriptionProject,
} from "./teams/channelDescription.ts";
import { TeamsResponseReferences, restoredTeamsSender } from "./teams/responseReferences.ts";
import { BridgeHub } from "./features/BridgeHub.ts";
import { App } from "@microsoft/teams.apps";
import { NodeRuntime } from "@effect/platform-node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ProviderUserInputAnswers } from "@t3tools/contracts";
import { DiscordBotConfig } from "./config.ts";
import { makeDiscordRestLayer } from "./discord/DiscordLive.ts";
import { resolveProjectFromShortName, startOrContinueT3Turn } from "./features/LinkedTurnRouter.ts";
import { bridgeThreadToPlatform, runBridge } from "./features/ResponseBridge.ts";
import { layer as bridgeHubLayer } from "./features/BridgeHub.ts";
import { BotResponseTransport } from "./features/BotResponseTransport.ts";
import { layer as warmCacheLayer } from "./store/ThreadWarmCacheStore.ts";
import {
  makeTeamsResponseTransport,
  type TeamsResponseActivity,
} from "./teams/ResponseTransport.ts";
import { IdentityMapStore, layerFromOptionalPath as identityMapLayer } from "./identityMap.ts";
import { layerFromOptionalPath as aliasesLayer } from "./projectAliases.ts";
import { ThreadLinkStore, layer as linksLayer } from "./store/ThreadLinkStore.ts";
import { T3Session, layer as sessionLayer } from "./t3/T3Session.ts";
import {
  botWasAdded,
  groupChatMirrorsFile,
  isTeamsGroupChat,
  teamsChannelSourceKey,
} from "./teams/groupChats.ts";
import { makeGroupChatTitleResolver } from "./teams/groupChatTitles.ts";
import {
  GRAPH_NOTIFICATIONS_PATH,
  graphNotificationUrl,
  readGatewayConfig,
  readPrivateCredential,
} from "./teams/gatewayConfig.ts";
import {
  GraphChatSubscriptions,
  makeGraphClient,
  pinnedGroupChatIds,
} from "./teams/graphChatSubscriptions.ts";
import {
  KeyedSerialQueue,
  graphChatMessageToActivity,
  graphNotificationRoute,
  type GraphChatMessage,
  type GraphNotificationBatch,
} from "./teams/graphNotifications.ts";
import {
  ensureTeamsMirrorLink,
  ingestTeamsGroupChat,
  teamsChannelPoster,
  type TeamsMirrorTurn,
} from "./features/TeamsGroupChatObserver.ts";
import { mentionsTeamsRecipient, registerTeamsMessageEvents } from "./teams/messageEvents.ts";
import { TeamsGatewayDispatcher } from "./teams/gatewayDispatcher.ts";
import {
  loadTeamsTurnImages,
  type TeamsActivityAttachment,
  type TeamsTurnImageLoad,
} from "./teams/inboundImages.ts";
import {
  LoopbackTeamsAdapter,
  RedactedTeamsLogger,
  type LoopbackRoute,
} from "./teams/gatewayHttp.ts";
import {
  TeamsGatewayPolicy,
  type GatewayActivity,
  type GatewayLease,
} from "./teams/gatewayPolicy.ts";

const decodeAnswers = Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderUserInputAnswers));

function readTeamsGatewayProcessEnv(): {
  readonly configPath: string | undefined;
  readonly secretPath: string | undefined;
  readonly stateDir: string | undefined;
} {
  return {
    configPath: process.env.TEAMS_GATEWAY_CONFIG,
    secretPath: process.env.TEAMS_GATEWAY_BOT_SECRET_FILE,
    stateDir: process.env.TEAMS_GATEWAY_STATE_DIR,
  };
}

const program = Effect.gen(function* () {
  const gatewayContext = yield* Effect.context<never>();
  const { configPath, secretPath, stateDir } = readTeamsGatewayProcessEnv();
  if (!configPath || !secretPath || !stateDir || !NodePath.isAbsolute(stateDir)) {
    return yield* Effect.die(
      new Error(
        "TEAMS_GATEWAY_CONFIG, TEAMS_GATEWAY_BOT_SECRET_FILE and absolute TEAMS_GATEWAY_STATE_DIR are required",
      ),
    );
  }
  const initial = readGatewayConfig(configPath);
  const discordRestLayer =
    initial.discord === undefined
      ? undefined
      : makeDiscordRestLayer(readPrivateCredential(initial.discord.tokenFile));
  // Explicit config provider prevents another tenant's credentials/defaults leaking from host env.
  const defaults = yield* DiscordBotConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
  );
  const entries = yield* Effect.forEach(
    Object.entries(initial.workspaces).filter(([, workspace]) => workspace.enabled),
    Effect.fn(function* ([id, workspace]) {
      const config: DiscordBotConfig = {
        ...defaults,
        t3HttpBaseUrl: workspace.t3HttpBaseUrl!,
        t3BearerToken: readPrivateCredential(workspace.credentialFile!),
        t3BootstrapCredential: undefined,
        dataDir: workspace.dataDir!,
        webUiBaseUrl: workspace.webOrigin,
        publicWebUiBaseUrl: workspace.publicWebOrigin ?? workspace.webOrigin,
        projectAliasesPath: workspace.projectAliasesPath,
        identityMapPath: workspace.identityMapPath,
        ...(workspace.defaultBaseBranch?.trim()
          ? { t3DefaultBaseBranch: workspace.defaultBaseBranch.trim() }
          : {}),
        t3DefaultInstanceId: workspace.defaultInstanceId ?? defaults.t3DefaultInstanceId,
        t3DefaultModel: workspace.defaultModel ?? defaults.t3DefaultModel,
        teamsEnabled: false,
        teamsNativeEnabled: false,
        ...(initial.discord === undefined
          ? {}
          : { alertsChannelId: initial.discord.alertsChannelId }),
      };
      NodeFS.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      if (NodeFS.statSync(config.dataDir).mode & 0o077)
        return yield* Effect.die(new Error("Workspace state must be private"));
      const services = Layer.mergeAll(
        bridgeHubLayer(runBridge),
        warmCacheLayer(config.dataDir),
        sessionLayer(config),
        linksLayer(config.dataDir),
        aliasesLayer(config.projectAliasesPath),
        identityMapLayer(config.identityMapPath),
      );
      const runtime = ManagedRuntime.make(
        discordRestLayer === undefined ? services : Layer.mergeAll(services, discordRestLayer),
      );
      yield* Effect.addFinalizer(() => runtime.disposeEffect);
      const identities = yield* Effect.promise(() => runtime.runPromise(IdentityMapStore));
      runtime.runFork(Effect.flatMap(T3Session, (session) => session.connectUntilReady()));
      return [id, { runtime, config, identities }] as const;
    }),
  );
  const workspaces = new Map(entries);
  const policy = new TeamsGatewayPolicy(
    () => readGatewayConfig(configPath),
    stateDir,
    (workspace, actor) =>
      workspaces
        .get(workspace)
        ?.identities.list()
        .some((person) => person.teams?.aadObjectId?.toLowerCase() === actor) === true,
    Date.now,
    initial,
  );
  yield* Effect.forkScoped(
    Effect.sync(() => {
      try {
        policy.sweep();
      } catch {
        /* config errors fail closed */
      }
    }).pipe(Effect.repeat(Schedule.spaced("30 seconds"))),
  );
  let running = true;
  const dispatcher = new TeamsGatewayDispatcher(policy);
  const teamsTokenCache = new Map<string, { token: string; expiresAt: number }>();
  const log = (level: "info" | "warning" | "error", message: string, fields = {}) =>
    Effect.runSyncWith(gatewayContext)(
      level === "info"
        ? Effect.logInfo(message, fields)
        : level === "warning"
          ? Effect.logWarning(message, fields)
          : Effect.logError(message, fields),
    );
  // Teams bot push misses chat messages; Graph change notifications deliver them as well.
  const notificationUrl = graphNotificationUrl(initial);
  const subscriptions =
    notificationUrl === null
      ? null
      : new GraphChatSubscriptions({
          graph: makeGraphClient({
            tenantId: initial.identity.homeTenantId,
            clientId: initial.identity.entraClientId,
            clientSecret: () => readPrivateCredential(secretPath),
            tokenCache: teamsTokenCache,
          }),
          stateDir,
          notificationUrl,
          chatIds: pinnedGroupChatIds(initial),
          log,
        });
  // Assigned below once the ingest path exists; Graph only calls it after app.start.
  let onGraphNotifications: (batch: GraphNotificationBatch) => Promise<void> = async () => {};
  const extraRoutes = new Map<string, LoopbackRoute>(
    subscriptions === null
      ? []
      : [
          [
            GRAPH_NOTIFICATIONS_PATH,
            graphNotificationRoute({
              clientState: subscriptions.clientState,
              onNotifications: (batch) => onGraphNotifications(batch),
              onError: (reason) => log("error", "Graph notification processing failed", { reason }),
            }),
          ],
        ],
  );
  const app = new App({
    clientId: initial.identity.entraClientId,
    clientSecret: readPrivateCredential(secretPath),
    tenantId: initial.identity.homeTenantId,
    messagingEndpoint: "/api/messages",
    skipAuth: false,
    activity: { mentions: { stripText: true } },
    logger: new RedactedTeamsLogger(),
    httpServerAdapter: new LoopbackTeamsAdapter(extraRoutes),
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      running = false;
      return app.stop();
    }),
  );

  const references = new TeamsResponseReferences(stateDir);
  const readDescription = makeTeamsChannelDescriptionReader({
    clientId: initial.identity.entraClientId,
    clientSecret: readPrivateCredential(secretPath),
  });
  const active = (lease: GatewayLease) => {
    if (!running || !policy.isActive(lease))
      throw new Error("Teams binding was revoked or changed");
    return workspaces.get(lease.binding.workspace)!;
  };
  const transportFor = (
    lease: GatewayLease,
    rootMessageId: string,
    send: (wire: TeamsResponseActivity) => Promise<{ id?: string }>,
    deleteMessage: (id: string) => Promise<unknown>,
  ) =>
    makeTeamsResponseTransport({
      config: active(lease).config,
      clientId: initial.identity.entraClientId,
      tenantId: lease.binding.tenantId,
      clientSecret: readPrivateCredential(secretPath),
      teamId: lease.binding.teamId,
      channelId: lease.binding.channelId,
      fileDestination: lease.binding.fileDestination,
      includeProgressHistory: lease.binding.includeProgressHistory,
      getChannelTopic: () => channelTopic(lease),
      conversationId: lease.conversationId,
      rootMessageId,
      assertActive: () => {
        active(lease);
      },
      send,
      deleteMessage,
    });
  // Turn-less delivery (restored or group-chat mirror bridges) posts with the bot's own envelope.
  const restoredTransport = (lease: GatewayLease, serviceUrl: string, rootMessageId: string) => {
    const api = new ApiClient(serviceUrl, app.api.http);
    const sendRestored = restoredTeamsSender({
      conversations: api.conversations,
      conversationId: lease.conversationId,
      botId: "28:" + initial.identity.entraClientId,
    });
    return transportFor(
      lease,
      rootMessageId,
      (wire) => {
        active(lease);
        return sendRestored(wire);
      },
      (id) => api.conversations.deleteActivity(lease.conversationId, id),
    );
  };
  // A mention in a group-chat mirror thread continues that chat's weekly T3 thread.
  const channelSourceKey = (lease: GatewayLease, dataDir: string) =>
    teamsChannelSourceKey({
      mirrorsFile: groupChatMirrorsFile(dataDir),
      tenantId: lease.binding.tenantId,
      teamId: lease.binding.teamId,
      channelId: lease.binding.channelId,
      conversationId: lease.conversationId,
    });
  const channelTopic = async (lease: GatewayLease) => {
    active(lease);
    if (lease.binding.useChannelDescription !== true) return "";
    const description = await readDescription({
      tenantId: lease.binding.tenantId,
      teamId: lease.binding.teamId,
      channelId: lease.binding.channelId,
      assertActive: () => {
        active(lease);
      },
    });
    return description;
  };

  app.on("card.action.omegent", async ({ activity, send, api }) => {
    const lease = policy.authorizeAction(activity as GatewayActivity);
    if (lease === null)
      return {
        statusCode: 200,
        type: "application/vnd.microsoft.activity.message" as const,
        value: "This action is no longer authorized.",
      };
    const workspace = active(lease);
    const data = activity.value.action.data as {
      command?: unknown;
      threadId?: unknown;
      requestId?: unknown;
    };
    const result = await workspace.runtime
      .runPromise(
        Effect.gen(function* () {
          const links = yield* ThreadLinkStore;
          const t3 = yield* T3Session;
          const sourceKey = channelSourceKey(lease, workspace.config.dataDir);
          const link = yield* links.getBySourceThread("teams", sourceKey);
          if (link === null || data.threadId !== link.t3ThreadId)
            return "This control belongs to another thread.";
          active(lease);
          if (data.command === "stop") yield* t3.interrupt(link.t3ThreadId);
          else if (
            (data.command === "approve" || data.command === "deny") &&
            typeof data.requestId === "string"
          )
            yield* t3.respondToApproval(
              link.t3ThreadId,
              data.requestId,
              data.command === "approve" ? "accept" : "decline",
            );
          else if (data.command === "continue") {
            const topic = yield* Effect.tryPromise(() => channelTopic(lease));
            const turn = yield* startOrContinueT3Turn(workspace.config, {
              source: { sourceKind: "teams", sourceThreadId: sourceKey },
              sourceActor: { platformId: lease.actorId },
              externalConversationId: lease.conversationId,
              externalParentId: lease.binding.teamId + "/" + lease.binding.channelId,
              externalTenantId: lease.binding.tenantId,
              projectShortName: teamsDescriptionProject(topic, lease.binding)!,
              channelTopic: topic,
              prompt: "Continue",
              flags: {},
              stickyModelOnContinue: true,
              promptContext: { kind: "raw", value: "Authorized Teams request: Continue" },
            });
            const transport = transportFor(
              lease,
              lease.conversationId.split(";messageid=")[1] ?? activity.replyToId ?? activity.id,
              (wire) => send(wire),
              (id) => api.conversations.deleteActivity(lease.conversationId, id),
            );
            yield* ensureTeamsMirrorLink({
              conversationId: lease.conversationId,
              sourceKey,
              t3ThreadId: turn.threadId,
            });
            yield* bridgeThreadToPlatform({
              conversationId: lease.conversationId,
              threadId: turn.threadId,
              sentUserMessageIds: [turn.messageId],
            }).pipe(Effect.provideService(BotResponseTransport, transport));
          } else return "Unsupported control.";
          return "Submitted.";
        }),
      )
      .catch(() => "The control could not be submitted.");
    return {
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message" as const,
      value: result,
    };
  });

  const groupChatTitle = makeGroupChatTitleResolver({
    clientId: initial.identity.entraClientId,
    clientSecret: () => readPrivateCredential(secretPath),
    tokenCache: teamsTokenCache,
  });
  // One "not watched" line per chat per process, so a busy unwatched chat can't flood the log.
  const reportedUnwatchedChats = new Set<string>();
  // One chat's messages ingest one at a time, whichever path delivered them.
  const groupChatQueue = new KeyedSerialQueue();
  let latestApi: Parameters<typeof teamsChannelPoster>[0] | undefined;
  const observeGroupChat = async (
    incoming: GatewayActivity & {
      readonly replyToId?: string;
      readonly attachments?: ReadonlyArray<TeamsActivityAttachment>;
    },
    api: Parameters<typeof teamsChannelPoster>[0],
    event: "message" | "join",
    source: "bot" | "graph" = "bot",
  ): Promise<boolean> => {
    if (
      !isTeamsGroupChat({
        conversationType: incoming.conversation.conversationType,
        isGroup: incoming.conversation.isGroup,
        teamId: incoming.channelData?.team?.id,
      })
    )
      return false;
    const title = await groupChatTitle({
      tenantId:
        incoming.channelData?.tenant?.id ??
        incoming.conversation.tenantId ??
        initial.identity.homeTenantId,
      conversationId: incoming.conversation.id,
      name: incoming.conversation.name,
    });
    const activity =
      title.source === "graph" && title.title !== undefined
        ? { ...incoming, conversation: { ...incoming.conversation, name: title.title } }
        : incoming;
    const decision = policy.acceptGroupChat(activity, source);
    if (decision.kind === "not-group") return false;
    const unwatched = decision.kind === "silent" && decision.reason === "unmapped";
    const chatId = activity.conversation.id.split(";messageid=")[0] ?? activity.conversation.id;
    if (unwatched && event !== "join" && !reportedUnwatchedChats.has(chatId)) {
      reportedUnwatchedChats.add(chatId);
      Effect.runSyncWith(gatewayContext)(
        Effect.logInfo("Teams group chat not watched", {
          chat: chatId.slice(0, 24),
          title: title.title ?? null,
          titleSource: title.source,
          graph: title.graph ?? null,
        }),
      );
    }
    const quiet =
      (unwatched && event !== "join") ||
      (decision.kind === "reject" && decision.reason === "duplicate");
    if (!quiet) {
      Effect.runSyncWith(gatewayContext)(
        Effect.logInfo("Teams group chat intake", {
          kind: decision.kind,
          reason: "reason" in decision ? decision.reason : undefined,
          workspaceId: decision.kind === "handle" ? decision.workspaceId : undefined,
        }),
      );
    }
    if (decision.kind !== "handle") return true;
    const workspace = workspaces.get(decision.workspaceId);
    if (workspace === undefined) return true;
    const handled = decision;
    if (source === "bot") latestApi = api;
    await groupChatQueue.run(chatId, () =>
      ingestGroupChat(activity, api, event, handled, workspace),
    );
    return true;
  };
  const ingestGroupChat = async (
    activity: Parameters<typeof observeGroupChat>[0],
    api: Parameters<typeof teamsChannelPoster>[0],
    event: "message" | "join",
    handled: Extract<ReturnType<typeof policy.acceptGroupChat>, { kind: "handle" }>,
    workspace: NonNullable<ReturnType<typeof workspaces.get>>,
  ): Promise<void> => {
    let images: TeamsTurnImageLoad = { uploads: [], note: "", warnings: [] };
    if (event === "message") {
      try {
        images = await loadTeamsTurnImages({
          tenantId:
            activity.channelData?.tenant?.id ??
            activity.conversation.tenantId ??
            initial.identity.homeTenantId,
          clientId: initial.identity.entraClientId,
          clientSecret: readPrivateCredential(secretPath),
          messageId: activity.id,
          ...(activity.replyToId === undefined ? {} : { replyToId: activity.replyToId }),
          ...(activity.text === undefined ? {} : { plainText: activity.text }),
          location: { kind: "chat", conversationId: activity.conversation.id },
          ...(activity.attachments === undefined ? {} : { attachments: activity.attachments }),
          tokenCache: teamsTokenCache,
          // The weekly log already holds this chat's earlier messages and their images.
          referencedDetail: "text",
        });
      } catch (error) {
        images = {
          uploads: [],
          note: "",
          warnings: [`Teams attachment intake failed: ${String(error)}`],
        };
      }
      for (const warning of images.warnings) {
        Effect.runSyncWith(gatewayContext)(
          Effect.logWarning("Teams attachment was not opened", { warning }),
        );
      }
    }
    await workspace.runtime
      .runPromise(
        Effect.gen(function* () {
          const runtime = yield* Effect.context<never>();
          yield* ingestTeamsGroupChat(
            workspace.config,
            handled.rules,
            workspace.identities.list(),
            runtime,
            {
              event,
              tenantId: activity.channelData?.tenant?.id ?? activity.conversation.tenantId ?? "",
              conversationId: activity.conversation.id,
              ...(activity.conversation.conversationType === undefined
                ? {}
                : { conversationType: activity.conversation.conversationType }),
              ...(activity.conversation.isGroup === undefined
                ? {}
                : { isGroup: activity.conversation.isGroup }),
              ...(activity.channelData?.team?.id === undefined
                ? {}
                : { teamId: activity.channelData.team.id }),
              ...(activity.conversation.name === undefined
                ? {}
                : { title: activity.conversation.name }),
              text: activity.text ?? "",
              messageId: activity.id,
              ...(activity.from?.name === undefined ? {} : { author: activity.from.name }),
              ...(activity.from?.aadObjectId === undefined
                ? {}
                : { authorAadObjectId: activity.from.aadObjectId }),
              ...(activity.from?.id === undefined ? {} : { authorUserId: activity.from.id }),
              fromBot: false,
              mentionedBot: mentionsTeamsRecipient(activity),
            },
            teamsChannelPoster(api),
            {
              builtinScanner: handled.builtinScanner,
              ...(handled.builtinMirror === undefined
                ? {}
                : { builtinMirror: handled.builtinMirror }),
              ...(handled.builtinDiscordChannelId === undefined
                ? {}
                : { builtinDiscordChannelId: handled.builtinDiscordChannelId }),
              ...(images.uploads.length > 0 || images.note.length > 0 ? { hasImages: true } : {}),
              ...(images.uploads.length > 0 ? { attachments: images.uploads } : {}),
              ...(images.note.length > 0 ? { attachmentNote: images.note } : {}),
              bridgeMirror: (turn) =>
                Effect.tryPromise(() => bridgeGroupChatMirror(handled.workspaceId, api, turn)),
            },
          );
        }),
      )
      .catch((error: unknown) => {
        Effect.runSyncWith(gatewayContext)(
          Effect.logError("Passive Teams group chat failed", { error: String(error) }),
        );
      });
  };

  // Same delivery as after a mention in the mirror thread, without one: the gateway started this
  // weekly T3 thread itself, so only its output is delivered; nothing new is authorized.
  const bridgeGroupChatMirror = async (
    workspaceId: string,
    api: Parameters<typeof teamsChannelPoster>[0],
    turn: TeamsMirrorTurn,
  ) => {
    const lease = policy.mirrorLease(workspaceId, turn.mirror, turn.conversationId);
    if (lease === null) {
      log("warning", "No active channel binding for the Teams group chat mirror", {
        workspaceId,
        channelId: turn.mirror.channelId,
      });
      return;
    }
    const workspace = active(lease);
    const rootMessageId = turn.conversationId.split(";messageid=")[1]!;
    references.remember(lease, api.serviceUrl, rootMessageId);
    const transport = restoredTransport(lease, api.serviceUrl, rootMessageId);
    await workspace.runtime.runPromise(
      Effect.gen(function* () {
        yield* ensureTeamsMirrorLink(turn);
        yield* bridgeThreadToPlatform({
          conversationId: turn.conversationId,
          threadId: turn.t3ThreadId,
          sentUserMessageIds: [turn.messageId],
        }).pipe(Effect.provideService(BotResponseTransport, transport));
      }),
    );
  };

  // Graph work per chat runs in arrival order, so reads cannot overtake each other.
  const graphQueue = new KeyedSerialQueue();
  const ingestGraphMessage = async (chatId: string, message: GraphChatMessage) => {
    const converted = graphChatMessageToActivity(message, {
      chatId,
      // Must equal the bot activity's tenant: it is part of the claim and the weekly thread key.
      tenantId: (await subscriptions?.chatTenant(chatId)) ?? initial.identity.homeTenantId,
      botAppId: initial.identity.entraClientId,
      serviceUrl: app.api.serviceUrl,
    });
    if (converted.kind === "skip") {
      subscriptions?.recordSeen(chatId, message.createdDateTime ?? undefined);
      return;
    }
    await observeGroupChat(converted.activity, latestApi ?? app.api, "message", "graph");
    subscriptions?.recordSeen(chatId, message.createdDateTime ?? undefined);
  };
  const catchUpChat = (chatId: string) =>
    graphQueue.run(chatId, async () => {
      const missed = await subscriptions?.missedMessages(chatId);
      if (missed === undefined || missed === null) return;
      if (missed.length > 0)
        log("info", "Graph catch-up", { chat: chatId.slice(0, 24), messages: missed.length });
      for (const message of missed) await ingestGraphMessage(chatId, message);
    });
  onGraphNotifications = async (batch) => {
    if (subscriptions === null || !running) return;
    const changes = batch.changes
      .filter((change) => subscriptions.isWatched(change.chatId))
      .toSorted((left, right) => Number(left.messageId) - Number(right.messageId));
    const reads = changes.map((change) =>
      graphQueue.run(change.chatId, async () => {
        const message = await subscriptions.getMessage(change.chatId, change.messageId);
        if (message !== null) await ingestGraphMessage(change.chatId, message);
      }),
    );
    for (const event of batch.lifecycle) {
      const chatId = subscriptions.chatForSubscription(event.subscriptionId);
      if (chatId === undefined) continue;
      log("info", "Graph subscription lifecycle", {
        chat: chatId.slice(0, 24),
        event: event.event,
      });
      if (event.event === "reauthorizationRequired") {
        if ((await subscriptions.renew(chatId)) === "created") await catchUpChat(chatId);
      } else if (event.event === "subscriptionRemoved") {
        if (await subscriptions.recreate(chatId)) await catchUpChat(chatId);
      } else await catchUpChat(chatId);
    }
    await Promise.all(reads);
  };

  registerTeamsMessageEvents(app, async ({ activity, send, reply, api }, edited) => {
    // Structural SDK activity type narrows to the fields read by the independent policy.
    const intake = edited
      ? {
          ...activity,
          type: "messageUpdate",
          channelData: { ...activity.channelData, eventType: "editMessage" },
        }
      : activity;
    if (await observeGroupChat(intake as GatewayActivity, api, "message")) return;
    const outcome = dispatcher.receive(
      intake as GatewayActivity,
      async (decision) => {
        const { lease } = decision;
        const workspace = active(lease);
        references.remember(
          lease,
          activity.serviceUrl ?? "",
          lease.conversationId.split(";messageid=")[1] ?? activity.replyToId ?? activity.id,
        );
        const deliver = async (text: string, first = false) => {
          active(lease);
          return first ? reply(text) : send(text);
        };
        const processMessage = Effect.gen(function* () {
          active(lease);
          const t3 = yield* T3Session;
          const links = yield* ThreadLinkStore;
          yield* t3.waitUntilReady({ timeoutMs: 15000 });
          active(lease);
          const topic = yield* Effect.tryPromise(() => channelTopic(lease));
          const projectShortName = teamsDescriptionProject(topic, lease.binding)!;
          const { project } = yield* resolveProjectFromShortName(projectShortName);
          if (
            projectShortName === lease.binding.projectShortName &&
            project.id !== lease.binding.projectId
          )
            return yield* Effect.fail("Teams project binding mismatch" as const);
          const sourceKey = channelSourceKey(lease, workspace.config.dataDir);
          const existing = yield* links.getBySourceThread("teams", sourceKey);
          if (existing !== null && existing.projectId !== project.id)
            return yield* Effect.fail("Existing Teams link belongs to another project" as const);
          if (existing !== null) {
            const snapshot = yield* t3.fetchThreadDetail(existing.t3ThreadId);
            if (snapshot !== null && snapshot.thread.projectId !== project.id)
              return yield* Effect.fail("Linked thread belongs to another project" as const);
            // Adopt the last answer delivered by the legacy poller before starting the first shared turn.
            if (
              snapshot?.thread.latestTurn?.state === "completed" &&
              existing.lastFinalizedAssistantId === null
            ) {
              yield* links.updateBridgeHints(lease.conversationId, {
                lastSeenTurnId: snapshot.thread.latestTurn.turnId,
                lastFinalizedAssistantId: snapshot.thread.latestTurn.assistantMessageId,
              });
            }
          }
          active(lease);
          const prompt = decision.text;
          if (/^(?:\/?stop|cancel)$/iu.test(prompt)) {
            if (existing !== null) yield* t3.interrupt(existing.t3ThreadId);
            yield* Effect.promise(() =>
              deliver(
                existing === null ? "There is no linked T3 thread." : "Stopped the active T3 turn.",
                true,
              ),
            );
            return;
          }
          const approval = /^(?:\/?)(approve|deny)\s+(\S+)$/iu.exec(prompt);
          if (approval !== null) {
            if (existing !== null)
              yield* t3.respondToApproval(
                existing.t3ThreadId,
                approval[2]!,
                approval[1]!.toLowerCase() === "approve" ? "accept" : "decline",
              );
            yield* Effect.promise(() =>
              deliver(
                existing === null
                  ? "There is no linked T3 thread."
                  : "Submitted the approval decision.",
                true,
              ),
            );
            return;
          }
          const answer = /^(?:\/?)answer\s+(\S+)\s+(.+)$/isu.exec(prompt);
          if (answer !== null) {
            if (existing === null) {
              yield* Effect.promise(() => deliver("There is no linked T3 thread.", true));
              return;
            }
            const answers = yield* decodeAnswers(answer[2]!);
            active(lease);
            yield* t3.respondToUserInput(existing.t3ThreadId, answer[1]!, answers);
            yield* Effect.promise(() => deliver("Submitted the requested input.", true));
            return;
          }
          const images = yield* Effect.tryPromise({
            try: () =>
              loadTeamsTurnImages({
                tenantId: lease.binding.tenantId,
                clientId: initial.identity.entraClientId,
                clientSecret: readPrivateCredential(secretPath),
                messageId: activity.id,
                ...(activity.replyToId === undefined ? {} : { replyToId: activity.replyToId }),
                ...(activity.text === undefined ? {} : { plainText: activity.text }),
                location: {
                  // Activity team.id is a conversation id. The binding stores the Entra group id.
                  kind: "channel",
                  teamId: lease.binding.teamId,
                  channelId: lease.binding.channelId,
                },
                ...(activity.attachments === undefined
                  ? {}
                  : { attachments: activity.attachments }),
                tokenCache: teamsTokenCache,
              }),
            catch: (cause) => String(cause),
          }).pipe(
            Effect.catch((cause) =>
              Effect.succeed({
                uploads: [],
                note: "",
                warnings: [`Teams attachment intake failed: ${cause}`],
              } satisfies TeamsTurnImageLoad),
            ),
          );
          for (const warning of images.warnings) {
            yield* Effect.logWarning("Teams attachment was not opened", { warning });
          }
          const requestText =
            prompt ||
            (images.uploads.length > 0
              ? "Look at the attached screenshot."
              : images.note.length > 0
                ? "Look at the attached files."
                : "");
          if (requestText.length === 0) return;
          const enriched = [
            decision.context,
            "Authorized Teams request:\n" + requestText,
            images.note,
          ]
            .filter((part) => part.trim().length > 0)
            .join("\n\n");
          const turn = yield* startOrContinueT3Turn(workspace.config, {
            source: { sourceKind: "teams", sourceThreadId: sourceKey },
            sourceActor: { platformId: lease.actorId },
            externalConversationId: lease.conversationId,
            externalParentId: lease.binding.teamId + "/" + lease.binding.channelId,
            externalTenantId: lease.binding.tenantId,
            projectShortName,
            channelTopic: topic,
            prompt: enriched,
            flags: {},
            stickyModelOnContinue: true,
            ...(images.uploads.length > 0 ? { attachments: images.uploads } : {}),
            promptContext: { kind: "raw", value: enriched },
          });
          const transport = transportFor(
            lease,
            lease.conversationId.split(";messageid=")[1] ?? activity.replyToId ?? activity.id,
            (wire) => send(wire),
            (id) => api.conversations.deleteActivity(lease.conversationId, id),
          );
          yield* ensureTeamsMirrorLink({
            conversationId: lease.conversationId,
            sourceKey,
            t3ThreadId: turn.threadId,
          });
          yield* bridgeThreadToPlatform({
            conversationId: lease.conversationId,
            threadId: turn.threadId,
            sentUserMessageIds: [turn.messageId],
          }).pipe(Effect.provideService(BotResponseTransport, transport));
        });
        await workspace.runtime.runPromise(processMessage).catch(async () => {
          try {
            await deliver(
              "T3 could not process this request. Please submit a new mention or contact an operator.",
              true,
            );
          } catch {
            /* revoked: no reply */
          }
        });
      },
      { allowEmptyText: true },
    );
    Effect.runSyncWith(gatewayContext)(Effect.logInfo("Teams intake:", outcome));
    // Acknowledge immediately; T3 work and Teams delivery continue on the host queue.
  });
  app.on("conversationUpdate", async ({ activity, api }) => {
    if (
      !botWasAdded({
        recipientId: activity.recipient?.id,
        memberIds: (activity.membersAdded ?? []).map((member) => member.id),
      })
    ) {
      return;
    }
    await observeGroupChat(activity as GatewayActivity, api, "join");
  });
  app.on("install.remove", async ({ activity }) => {
    policy.revoke(activity as GatewayActivity);
  });
  // Personal chats and message-action project overrides have no binding. Group chats are observed above.
  app.on("message.ext.open", async () => ({
    task: {
      type: "message" as const,
      value: "Mention the bot in an authorized channel to start T3.",
    },
  }));
  app.on("message.ext.submit", async () => ({
    task: {
      type: "message" as const,
      value: "Mention the bot in an authorized channel to start T3.",
    },
  }));
  yield* Effect.promise(() => app.start(Number(initial.ingress.dispatcherListen.split(":")[1])));
  if (subscriptions !== null) {
    const graph = subscriptions;
    // Graph validates the callback while creating a subscription, so this runs after start.
    const maintain = (catchUpAll: boolean) =>
      Effect.tryPromise(async () => {
        const created = await graph.reconcile();
        const chats = catchUpAll ? pinnedGroupChatIds(initial) : created;
        await Promise.all(chats.map((chatId) => catchUpChat(chatId)));
      }).pipe(Effect.catchCause(() => Effect.logWarning("Graph subscription maintenance failed")));
    yield* Effect.forkScoped(
      maintain(true).pipe(
        Effect.andThen(
          maintain(false).pipe(
            Effect.repeat(Schedule.spaced("1 minute")),
            Effect.delay("1 minute"),
          ),
        ),
      ),
    );
  }
  for (const reference of references.restore(initial, (lease) => policy.isActive(lease))) {
    const { lease } = reference;
    const workspace = active(lease);
    const transport = restoredTransport(lease, reference.serviceUrl, reference.rootMessageId);
    workspace.runtime.runFork(
      Effect.gen(function* () {
        const links = yield* ThreadLinkStore;
        // Keyed by conversation: native channel threads and group-chat mirror threads alike.
        const link = yield* links.getByDiscordThreadId(lease.conversationId);
        if (link === null) return;
        const session = yield* T3Session;
        // Startup connection runs in another fiber; rehydration must not subscribe before it is ready.
        yield* session.waitUntilReady().pipe(
          Effect.retry({
            schedule: Schedule.spaced("1 second"),
            while: () => policy.isActive(lease),
          }),
        );
        if (!policy.isActive(lease)) return;
        const hub = yield* BridgeHub;
        yield* hub
          .ensure({
            discordChannelId: lease.conversationId,
            t3ThreadId: link.t3ThreadId,
            mode: "rehydrate",
            lastActivityAt: link.lastActivityAt,
          })
          .pipe(Effect.provideService(BotResponseTransport, transport));
        yield* Effect.logInfo("Teams response bridge restored after T3 readiness", {
          workspace: lease.binding.workspace,
          threadId: link.t3ThreadId,
        });
      }).pipe(Effect.catchCause(() => Effect.logWarning("Teams response restore failed"))),
    );
  }
  yield* Effect.logInfo("Shared Teams gateway started", { workspaces: entries.map(([id]) => id) });
  return yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(program));
