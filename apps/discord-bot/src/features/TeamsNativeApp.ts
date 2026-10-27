// @effect-diagnostics anyUnknownInErrorContext:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off globalPromise:off missingEffectContext:off tryCatchInEffectGen:off preferSchemaOverJson:off
import { App } from "@microsoft/teams.apps";
import type * as Context from "effect/Context";
import { ProviderUserInputAnswers } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { TeamsSeenStore, layer as teamsSeenLayer } from "../store/TeamsSeenStore.ts";
import {
  mentionsTeamsRecipient,
  registerTeamsMessageEvents,
  type TeamsMessageContext,
} from "../teams/messageEvents.ts";

import type { DiscordBotConfig } from "../config.ts";
import { classifyTeamsAgentAccess, IdentityMapStore, type PersonIdentity } from "../identityMap.ts";
import { ProjectAliasStore } from "../projectAliases.ts";
import { ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { T3Session } from "../t3/T3Session.ts";
import { loadTeamsChannelConfigsFromFileSync, type TeamsChannelConfig } from "../teams/config.ts";
import {
  botWasAdded,
  groupChatSourceKey,
  isTeamsGroupChat,
  loadGroupChatRulesFromFileSync,
} from "../teams/groupChats.ts";
import { ingestTeamsGroupChat, type TeamsChannelPoster } from "./TeamsGroupChatObserver.ts";
import {
  makeTeamsChannelDescriptionReader,
  teamsDescriptionProject,
} from "../teams/channelDescription.ts";
import { teamsMessageActionPrompt } from "../teams/attribution.ts";
import { startOrContinueT3Turn } from "./LinkedTurnRouter.ts";
import { bridgeThreadToPlatform } from "./ResponseBridge.ts";
import { BridgeHub } from "./BridgeHub.ts";
import { ThreadWarmCacheStore } from "../store/ThreadWarmCacheStore.ts";
import { BotResponseTransport } from "./BotResponseTransport.ts";
import { makeTeamsResponseTransport } from "../teams/ResponseTransport.ts";

function teamsChannelPoster(api: TeamsMessageContext["api"]): TeamsChannelPoster {
  return {
    openThread: (input) =>
      api.conversations.create({
        tenantId: input.mirror.tenantId,
        isGroup: true,
        channelData: {
          channel: { id: input.mirror.channelId },
          team: { id: input.mirror.teamId, aadGroupId: input.mirror.teamId },
          tenant: { id: input.mirror.tenantId },
        },
        activity: { type: "message", text: input.text },
      }),
    reply: (conversationId, text) =>
      api.conversations
        .createActivity(conversationId, { type: "message", text })
        .then(() => undefined),
  };
}

interface TeamsConversationCoordinates {
  readonly tenantId: string;
  readonly teamId: string | undefined;
  readonly channelId: string | undefined;
  readonly conversationId: string;
}

function coordinates(activity: {
  readonly conversation: { readonly id: string; readonly tenantId?: string | undefined };
  readonly channelData?: {
    readonly tenant?: { readonly id?: string | undefined } | undefined;
    readonly team?: { readonly id?: string | undefined } | undefined;
    readonly channel?: { readonly id?: string | undefined } | undefined;
  };
}): TeamsConversationCoordinates {
  return {
    tenantId: activity.channelData?.tenant?.id ?? activity.conversation.tenantId ?? "",
    teamId: activity.channelData?.team?.id,
    channelId: activity.channelData?.channel?.id,
    conversationId: activity.conversation.id,
  };
}

function channelForCoordinates(
  channels: ReadonlyArray<TeamsChannelConfig>,
  input: TeamsConversationCoordinates,
): TeamsChannelConfig | undefined {
  return channels.find(
    (channel) => channel.teamId === input.teamId && channel.channelId === input.channelId,
  );
}

export function sourceConversationKey(input: TeamsConversationCoordinates): string {
  return `native/${input.tenantId}/${input.teamId ?? "chat"}/${input.channelId ?? "chat"}/${input.conversationId}`;
}

function teamsActorAccess(
  people: ReadonlyArray<PersonIdentity>,
  from:
    | {
        readonly id?: string | undefined;
        readonly name?: string | undefined;
        readonly aadObjectId?: string | undefined;
      }
    | null
    | undefined,
) {
  return classifyTeamsAgentAccess({
    people,
    aadObjectId: from?.aadObjectId ?? null,
    userId: from?.id ?? null,
    displayName: from?.name ?? null,
  });
}

/**
 * Native Teams SDK endpoint. This is independent from Discord gateway/services and can be
 * deployed with only Teams + T3 credentials.
 */
function messageActionCard(defaultProject: string | undefined) {
  return {
    contentType: "application/vnd.microsoft.card.adaptive",
    content: {
      type: "AdaptiveCard",
      version: "1.5",
      body: [
        {
          type: "TextBlock",
          text: "Start a T3 investigation from this Teams message",
          weight: "Bolder",
          wrap: true,
        },
        {
          type: "Input.Text",
          id: "projectShortName",
          label: "Project alias",
          value: defaultProject ?? "",
          isRequired: true,
          errorMessage: "Enter a project alias configured in T3_PROJECT_ALIASES_PATH.",
        },
        {
          type: "Input.Text",
          id: "instructions",
          label: "Additional instructions",
          isMultiline: true,
          placeholder: "Optional context or desired outcome",
        },
        {
          type: "ActionSet",
          actions: [
            {
              type: "Action.Submit",
              title: "Start investigation",
              data: { action: "startT3Investigation" },
            },
          ],
        },
      ],
      $schema: "https://adaptivecards.io/schemas/adaptive-card.json",
    },
  } as const;
}

export const runTeamsNativeApp = Effect.fn("runTeamsNativeApp")(function* (
  config: DiscordBotConfig,
) {
  if (!config.teamsNativeEnabled) {
    yield* Effect.logInfo("Native Teams app disabled");
    return;
  }
  if (
    config.teamsClientId === undefined ||
    config.teamsClientSecret === undefined ||
    config.teamsTenantId === undefined
  ) {
    return yield* Effect.fail(
      new Error(
        "TEAMS_NATIVE_ENABLED requires TEAMS_CLIENT_ID, TEAMS_CLIENT_SECRET, and TEAMS_TENANT_ID.",
      ),
    );
  }

  const channels =
    config.teamsChannelsPath === undefined
      ? []
      : loadTeamsChannelConfigsFromFileSync(config.teamsChannelsPath);
  const groupChatRules =
    config.teamsChannelsPath === undefined
      ? []
      : loadGroupChatRulesFromFileSync(config.teamsChannelsPath);
  const identityMap = yield* IdentityMapStore;
  const t3 = yield* T3Session;
  const links = yield* ThreadLinkStore;
  const services = yield* Effect.context<
    ProjectAliasStore | T3Session | ThreadLinkStore | BridgeHub | ThreadWarmCacheStore
  >();
  const runtime = services as Context.Context<never>;
  const run = Effect.runPromiseWith(services);
  const receipts = yield* TeamsSeenStore.pipe(
    Effect.provide(teamsSeenLayer(config.dataDir, "teams-native-receipts.json")),
  );
  const intakeLock = yield* Semaphore.make(1);

  const readDescription = makeTeamsChannelDescriptionReader({
    clientId: config.teamsClientId!,
    clientSecret: config.teamsClientSecret!,
  });
  const channelTopic = async (
    channel: TeamsChannelConfig | undefined,
    location: TeamsConversationCoordinates,
    assertActive: () => void,
  ) => {
    if (!channel?.useChannelDescription || !location.teamId || !location.channelId) return "";
    const description = await readDescription({
      tenantId: location.tenantId,
      teamId: location.teamId,
      channelId: location.channelId,
      assertActive,
    });
    return description;
  };
  const app = new App({
    clientId: config.teamsClientId,
    clientSecret: config.teamsClientSecret,
    tenantId: config.teamsTenantId,
    messagingEndpoint: config.teamsMessagingEndpoint,
    activity: { mentions: { stripText: true } },
  });

  app.on("card.action.omegent", async ({ activity, send, api }) => {
    const access = teamsActorAccess(identityMap.list(), activity.from);
    const location = coordinates(activity);
    const data = activity.value.action.data as {
      command?: unknown;
      threadId?: unknown;
      requestId?: unknown;
    };
    const result = await run(
      Effect.gen(function* () {
        if (!access.allowed) return access.userMessage;
        const channel = channelForCoordinates(channels, location);
        if (!channel) return "This channel is not configured.";
        const sourceKey = sourceConversationKey(location);
        const link = yield* links.getBySourceThread("teams", sourceKey);
        if (!link || data.threadId !== link.t3ThreadId)
          return "This control belongs to another thread.";
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
          const topic = yield* Effect.tryPromise(() =>
            channelTopic(channel, location, () => {
              if (!teamsActorAccess(identityMap.list(), activity.from).allowed)
                throw new Error("Teams actor access revoked");
            }),
          );
          const turn = yield* startOrContinueT3Turn(config, {
            source: { sourceKind: "teams", sourceThreadId: sourceKey },
            sourceActor: {
              platformId: activity.from.aadObjectId ?? activity.from.id,
              displayName: access.person.name,
            },
            externalConversationId: location.conversationId,
            externalParentId: `${location.teamId}/${location.channelId}`,
            externalTenantId: location.tenantId,
            projectShortName: teamsDescriptionProject(topic, channel)!,
            channelTopic: topic,
            prompt: "Continue",
            flags: {},
            stickyModelOnContinue: true,
            promptContext: { kind: "raw", value: "Continue" },
          });
          const transport = makeTeamsResponseTransport({
            config,
            clientId: config.teamsClientId!,
            tenantId: location.tenantId,
            clientSecret: config.teamsClientSecret!,
            teamId: location.teamId ?? "",
            channelId: location.channelId ?? "",
            fileDestination: channel?.fileDestination,
            includeProgressHistory: channel?.includeProgressHistory,
            getChannelTopic: () =>
              channelTopic(channel, location, () => {
                if (!teamsActorAccess(identityMap.list(), activity.from).allowed)
                  throw new Error("Teams actor access revoked");
              }),
            conversationId: location.conversationId,
            rootMessageId:
              location.conversationId.split(";messageid=")[1] ?? activity.replyToId ?? activity.id,
            assertActive: () => {
              if (!teamsActorAccess(identityMap.list(), activity.from).allowed)
                throw new Error("Teams actor access revoked");
            },
            send: (wire) => send(wire),
            deleteMessage: (id) => api.conversations.deleteActivity(location.conversationId, id),
          });
          yield* bridgeThreadToPlatform({
            conversationId: location.conversationId,
            threadId: turn.threadId,
            sentUserMessageIds: [turn.messageId],
          }).pipe(Effect.provideService(BotResponseTransport, transport));
        } else return "Unsupported control.";
        return "Submitted.";
      }),
    ).catch(() => "The control could not be submitted.");
    return {
      statusCode: 200,
      type: "application/vnd.microsoft.activity.message" as const,
      value: result,
    };
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
    const location = coordinates(activity);
    if (
      !isTeamsGroupChat({
        conversationType: activity.conversation.conversationType,
        isGroup: activity.conversation.isGroup,
        teamId: location.teamId,
      })
    ) {
      return;
    }
    await run(
      Effect.gen(function* () {
        const sourceKey = groupChatSourceKey(location.tenantId, location.conversationId);
        const claimed = yield* intakeLock.withPermit(
          Effect.gen(function* () {
            if (yield* receipts.hasSeen(sourceKey, "joined")) return false;
            yield* receipts.markSeen(sourceKey, "joined");
            return true;
          }),
        );
        if (!claimed) return;
        yield* ingestTeamsGroupChat(
          config,
          groupChatRules,
          identityMap.list(),
          runtime,
          {
            event: "join",
            tenantId: location.tenantId,
            conversationId: location.conversationId,
            conversationType: activity.conversation.conversationType,
            isGroup: activity.conversation.isGroup,
            teamId: location.teamId,
            title: activity.conversation.name ?? activity.topicName,
            text: "",
            fromBot: false,
            mentionedBot: false,
          },
          teamsChannelPoster(api),
        ).pipe(
          Effect.catch((error) =>
            Effect.logError("Passive Teams group chat join failed", { error: String(error) }),
          ),
        );
      }),
    );
  });

  registerTeamsMessageEvents(app, async ({ activity, api, send, reply }) => {
    await run(
      Effect.gen(function* () {
        const location = coordinates(activity);
        if (
          isTeamsGroupChat({
            conversationType: activity.conversation.conversationType,
            isGroup: activity.conversation.isGroup,
            teamId: location.teamId,
          })
        ) {
          const sourceKey = groupChatSourceKey(location.tenantId, location.conversationId);
          const claimed = yield* intakeLock.withPermit(
            Effect.gen(function* () {
              if (yield* receipts.hasSeen(sourceKey, activity.id)) return false;
              yield* receipts.markSeen(sourceKey, activity.id);
              return true;
            }),
          );
          if (!claimed) return;
          yield* ingestTeamsGroupChat(
            config,
            groupChatRules,
            identityMap.list(),
            runtime,
            {
              event: "message",
              tenantId: location.tenantId,
              conversationId: location.conversationId,
              conversationType: activity.conversation.conversationType,
              isGroup: activity.conversation.isGroup,
              teamId: location.teamId,
              title: activity.conversation.name,
              text: activity.text ?? "",
              messageId: activity.id,
              author: activity.from?.name,
              authorAadObjectId: activity.from?.aadObjectId,
              authorUserId: activity.from?.id,
              fromBot:
                activity.from?.id !== undefined && activity.from.id === activity.recipient?.id,
              mentionedBot: mentionsTeamsRecipient(activity),
            },
            teamsChannelPoster(api),
          ).pipe(
            Effect.catch((error) =>
              Effect.logError("Passive Teams group chat failed", { error: String(error) }),
            ),
          );
          return;
        }

        const access = teamsActorAccess(identityMap.list(), activity.from);
        if (!access.allowed) {
          yield* Effect.logWarning("Rejected native Teams interaction from unmapped identity", {
            reason: access.reason,
            userId: activity.from?.id ?? null,
            aadObjectId: activity.from?.aadObjectId ?? null,
          });
          yield* Effect.promise(() => reply(access.userMessage));
          return;
        }

        if (location.teamId && !mentionsTeamsRecipient(activity)) return;
        const sourceKey = sourceConversationKey(location);
        const claimed = yield* intakeLock.withPermit(
          Effect.gen(function* () {
            if (yield* receipts.hasSeen(sourceKey, activity.id)) return false;
            yield* receipts.markSeen(sourceKey, activity.id);
            return true;
          }),
        );
        if (!claimed) return;
        const channel = channelForCoordinates(channels, location);
        const topic = yield* Effect.tryPromise(() =>
          channelTopic(channel, location, () => {
            if (!teamsActorAccess(identityMap.list(), activity.from).allowed)
              throw new Error("Teams actor access revoked");
          }),
        );
        const projectShortName = channel
          ? teamsDescriptionProject(topic, channel)
          : config.teamsDefaultProjectShortName;
        const prompt = (activity.text ?? "").trim();
        const existing = yield* links.getBySourceThread("teams", sourceKey);

        const stop = /^(?:\/?stop|cancel)$/iu.test(prompt);
        if (stop) {
          if (existing === null) {
            yield* Effect.promise(() => reply("There is no linked T3 thread to stop."));
            return;
          }
          yield* t3.interrupt(existing.t3ThreadId);
          yield* Effect.promise(() => reply("Stopped the active T3 turn."));
          return;
        }

        const approval = /^(?:\/?)(approve|deny)\s+(\S+)$/iu.exec(prompt);
        if (approval !== null) {
          if (existing === null) {
            yield* Effect.promise(() => reply("There is no linked T3 thread for that approval."));
            return;
          }
          yield* t3.respondToApproval(
            existing.t3ThreadId,
            approval[2]!,
            approval[1]!.toLowerCase() === "approve" ? "accept" : "decline",
          );
          yield* Effect.promise(() => reply(`Approval ${approval[1]!.toLowerCase()}ed.`));
          return;
        }

        const userInput = /^(?:\/?)answer\s+(\S+)\s+(.+)$/isu.exec(prompt);
        if (userInput !== null) {
          if (existing === null) {
            yield* Effect.promise(() =>
              reply("There is no linked T3 thread for that input request."),
            );
            return;
          }
          const parsed = yield* Effect.try({
            try: () => JSON.parse(userInput[2]!) as unknown,
            catch: () => new Error("Answers must be a JSON object."),
          }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(ProviderUserInputAnswers)));
          yield* t3.respondToUserInput(existing.t3ThreadId, userInput[1]!, parsed);
          yield* Effect.promise(() => reply("Submitted the requested input to T3."));
          return;
        }

        if (prompt.length === 0) return;
        if (projectShortName === undefined) {
          yield* Effect.promise(() =>
            reply(
              "No T3 project is mapped to this Teams location. Configure TEAMS_CHANNELS_PATH or TEAMS_DEFAULT_PROJECT_SHORT_NAME.",
            ),
          );
          return;
        }

        const turn = yield* startOrContinueT3Turn(config, {
          source: { sourceKind: "teams", sourceThreadId: sourceKey },
          sourceActor: {
            platformId: activity.from.aadObjectId ?? activity.from.id,
            displayName: access.person.name,
          },
          externalConversationId: location.conversationId,
          externalParentId: `${location.teamId ?? "chat"}/${location.channelId ?? "chat"}`,
          externalTenantId: location.tenantId,
          projectShortName,
          channelTopic: topic,
          prompt,
          flags: {},
          stickyModelOnContinue: true,
          promptContext: { kind: "raw", value: prompt },
        });

        const receivedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
        const transport = makeTeamsResponseTransport({
          config,
          clientId: config.teamsClientId!,
          tenantId: location.tenantId,
          clientSecret: config.teamsClientSecret!,
          teamId: location.teamId ?? "",
          channelId: location.channelId ?? "",
          fileDestination: channel?.fileDestination,
          includeProgressHistory: channel?.includeProgressHistory,
          getChannelTopic: () =>
            channelTopic(channel, location, () => {
              if (!teamsActorAccess(identityMap.list(), activity.from).allowed)
                throw new Error("Teams actor access revoked");
            }),
          conversationId: location.conversationId,
          rootMessageId:
            activity.replyToId ?? location.conversationId.split(";messageid=")[1] ?? activity.id,
          incomingMessage: {
            id: activity.id,
            content: activity.text ?? "",
            author: { id: activity.from.aadObjectId ?? activity.from.id },
            timestamp: activity.timestamp?.toISOString() ?? receivedAt,
          },
          assertActive: () => {
            if (!teamsActorAccess(identityMap.list(), activity.from).allowed)
              throw new Error("Teams actor access revoked");
          },
          send: (wire) => send(wire),
          deleteMessage: (id) => api.conversations.deleteActivity(location.conversationId, id),
        });
        yield* bridgeThreadToPlatform({
          conversationId: location.conversationId,
          threadId: turn.threadId,
          sentUserMessageIds: [turn.messageId],
        }).pipe(Effect.provideService(BotResponseTransport, transport));
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("Native Teams message failed", { error: String(error) }).pipe(
            Effect.andThen(
              Effect.promise(() =>
                reply(
                  "T3 could not process this message. Check the bridge logs and configuration.",
                ),
              ),
            ),
          ),
        ),
      ),
    );
  });

  app.on("message.ext.open", async ({ activity }) => {
    const access = teamsActorAccess(identityMap.list(), activity.from);
    if (!access.allowed) {
      return { task: { type: "message" as const, value: access.userMessage } };
    }
    const location = coordinates(activity);
    const channel = channelForCoordinates(channels, location);
    return {
      task: {
        type: "continue",
        value: {
          title: "Start T3 investigation",
          height: "medium",
          width: "medium",
          card: messageActionCard(channel?.projectShortName ?? config.teamsDefaultProjectShortName),
        },
      },
    };
  });

  app.on("message.ext.submit", async ({ activity }) => {
    const access = teamsActorAccess(identityMap.list(), activity.from);
    if (!access.allowed) {
      return { task: { type: "message" as const, value: access.userMessage } };
    }
    const data = activity.value.data as
      | { readonly projectShortName?: unknown; readonly instructions?: unknown }
      | undefined;
    const projectShortName =
      typeof data?.projectShortName === "string" ? data.projectShortName.trim() : "";
    if (projectShortName.length === 0) {
      return { task: { type: "message", value: "A project alias is required." } };
    }
    const selectedMessage = activity.value.messagePayload;
    const instructions = typeof data?.instructions === "string" ? data.instructions.trim() : "";
    const prompt = teamsMessageActionPrompt({
      message: {
        id: selectedMessage?.id ?? activity.id,
        replyToId: selectedMessage?.replyToId,
        body: selectedMessage?.body,
        from: selectedMessage?.from,
      },
      requester: access.person,
      people: identityMap.list(),
      instructions,
    });
    const location = coordinates(activity);
    const messageId = activity.value.messagePayload?.id ?? activity.id;
    const sourceKey = `message-action/${location.tenantId}/${messageId}`;

    Effect.runForkWith(services)(
      startOrContinueT3Turn(config, {
        source: { sourceKind: "teams", sourceThreadId: sourceKey },
        sourceActor: {
          platformId: activity.from.aadObjectId ?? activity.from.id,
          displayName: access.person.name,
        },
        externalConversationId: sourceKey,
        externalParentId: `${location.teamId ?? "chat"}/${location.channelId ?? "chat"}`,
        externalTenantId: location.tenantId,
        projectShortName,
        prompt,
        flags: {},
        promptContext: { kind: "raw", value: prompt },
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Teams message action failed", { sourceKey, cause }),
        ),
      ),
    );
    return {
      task: {
        type: "message",
        value: "T3 investigation started. Open T3 Code to follow progress.",
      },
    };
  });

  yield* Effect.tryPromise({
    try: () => app.start(config.teamsPort),
    catch: (cause) => new Error(`Could not start native Teams app: ${String(cause)}`),
  });
  yield* Effect.logInfo("Native Teams app listening", {
    port: config.teamsPort,
    endpoint: config.teamsMessagingEndpoint,
  });
});
