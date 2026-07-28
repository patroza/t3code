// @effect-diagnostics anyUnknownInErrorContext:off missingEffectContext:off globalFetch:off globalTimers:off missingEffectError:off globalDateInEffect:off globalDate:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off globalFetchInEffect:off preferSchemaOverJson:off
import { DiscordConfig, DiscordREST } from "dfx";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type { DiscordBotConfig } from "../config.ts";
import { createMessageWithAttachments, DiscordUploadError } from "../presentation/discordFiles.ts";
import { TeamsSeenStore } from "../store/TeamsSeenStore.ts";
import { ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { truncateTitle } from "../presentation/messages.ts";
import { startOrContinueLinkedTurn, startOrContinueT3Turn } from "./LinkedTurnRouter.ts";
import type { DiscordUploadFile } from "../presentation/discordFiles.ts";
import { downloadTeamsMessageImages } from "../teams/attachments.ts";
import { loadTeamsChannelConfigsFromFileSync, type TeamsChannelConfig } from "../teams/config.ts";
import {
  buildTeamsIncidentTitle,
  buildTeamsPrompt,
  buildTeamsSeedMessage,
  hasAllowlistedReaction,
  hasInternalTagTrigger,
  isHumanTeamsMessage,
  looksLikeGermanProblemReport,
  mentionsTeamsBot,
  rootTeamsMessageId,
  teamsMessageTimestamp,
  type TeamsMessage,
} from "../teams/presentation.ts";

interface GraphListResponse {
  readonly value?: ReadonlyArray<TeamsMessage> | undefined;
  readonly "@odata.nextLink"?: string | undefined;
}

interface GraphHostedContentResponse {
  readonly value?:
    | ReadonlyArray<{
        readonly id?: string | undefined;
        readonly contentType?: string | undefined;
      }>
    | undefined;
}

function channelKey(channel: TeamsChannelConfig): string {
  return `${channel.teamId}/${channel.channelId}`;
}

function sourceThreadKey(channel: TeamsChannelConfig, rootMessageId: string): string {
  return `${channel.teamId}/${channel.channelId}/${rootMessageId}`;
}

function oauthRequestBody(config: DiscordBotConfig): URLSearchParams {
  const body = new URLSearchParams();
  body.set("grant_type", "client_credentials");
  body.set("client_id", config.teamsClientId ?? "");
  body.set("client_secret", config.teamsClientSecret ?? "");
  body.set("scope", "https://graph.microsoft.com/.default");
  return body;
}

async function fetchJson(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  const response = await globalThis.fetch(input, init);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return (await response.json()) as unknown;
}

function nowLookbackStart(): Date {
  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  if (dayOfWeek === 6 || dayOfWeek === 0 || dayOfWeek === 1) {
    const daysSinceFriday = dayOfWeek === 6 ? 1 : dayOfWeek === 0 ? 2 : 3;
    const friday = new Date(now);
    friday.setUTCDate(now.getUTCDate() - daysSinceFriday);
    friday.setUTCHours(0, 0, 0, 0);
    return friday;
  }

  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

export const runTeamsModule = Effect.fn("runTeamsModule")(function* (config: DiscordBotConfig) {
  if (!config.teamsEnabled) {
    yield* Effect.logInfo("Teams module disabled");
    return;
  }
  if (
    !config.teamsTenantId ||
    !config.teamsClientId ||
    !config.teamsClientSecret ||
    !config.teamsChannelsPath
  ) {
    yield* Effect.logWarning("Teams module enabled but auth/config is incomplete; skipping");
    return;
  }

  const channels = loadTeamsChannelConfigsFromFileSync(config.teamsChannelsPath);
  if (channels.length === 0) {
    yield* Effect.logWarning("Teams module enabled but channel config is empty; skipping");
    return;
  }

  const rest = yield* DiscordREST;
  const discordConfig = yield* DiscordConfig.DiscordConfig;
  const seenStore = yield* TeamsSeenStore;
  const links = yield* ThreadLinkStore;

  let cachedAccessToken: { readonly token: string; readonly expiresAt: number } | null = null;

  const getAccessToken = Effect.fn("runTeamsModule.getAccessToken")(function* () {
    const now = Date.now();
    if (cachedAccessToken !== null && cachedAccessToken.expiresAt > now + 60_000) {
      return cachedAccessToken.token;
    }

    const tokenResponse = (yield* Effect.tryPromise({
      try: () =>
        fetchJson(`https://login.microsoftonline.com/${config.teamsTenantId}/oauth2/v2.0/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
          },
          body: oauthRequestBody(config),
        }),
      catch: (cause) => new Error(String(cause)),
    })) as {
      readonly access_token?: string;
      readonly expires_in?: number;
    };

    const token = tokenResponse.access_token ?? "";
    const expiresIn = tokenResponse.expires_in ?? 3600;
    if (token.length === 0) {
      return yield* Effect.fail(
        new Error("Microsoft Graph token response did not include access_token."),
      );
    }
    cachedAccessToken = {
      token,
      expiresAt: now + expiresIn * 1000,
    };
    return token;
  });

  const graphGet = Effect.fn("runTeamsModule.graphGet")(function* (pathOrUrl: string) {
    const accessToken = yield* getAccessToken();
    return (yield* Effect.tryPromise({
      try: () =>
        fetchJson(
          pathOrUrl.startsWith("https://")
            ? pathOrUrl
            : `https://graph.microsoft.com/v1.0${pathOrUrl}`,
          {
            headers: {
              authorization: `Bearer ${accessToken}`,
            },
          },
        ),
      catch: (cause) => new Error(String(cause)),
    })) as GraphListResponse;
  });

  const graphGetUnknown = Effect.fn("runTeamsModule.graphGetUnknown")(function* (path: string) {
    const accessToken = yield* getAccessToken();
    return yield* Effect.tryPromise({
      try: () =>
        fetchJson(`https://graph.microsoft.com/v1.0${path}`, {
          headers: {
            authorization: `Bearer ${accessToken}`,
          },
        }),
      catch: (cause) => new Error(String(cause)),
    });
  });

  const messageIsWithinLookback = (message: TeamsMessage, lookbackStartMs: number): boolean => {
    const createdAt = Date.parse(message.createdDateTime ?? "");
    return !Number.isFinite(createdAt) || createdAt >= lookbackStartMs;
  };

  const listPagedMessages = Effect.fn("runTeamsModule.listPagedMessages")(function* (
    initialPath: string,
    lookbackStartMs: number,
  ) {
    const collected: TeamsMessage[] = [];
    let cursor: string | null = initialPath;

    while (cursor !== null) {
      const page: GraphListResponse = yield* graphGet(cursor);
      const pageMessages: TeamsMessage[] = [...(page.value ?? [])];
      collected.push(...pageMessages);

      const shouldContinue: boolean = pageMessages.some((message: TeamsMessage) =>
        messageIsWithinLookback(message, lookbackStartMs),
      );
      cursor = shouldContinue ? (page["@odata.nextLink"] ?? null) : null;
    }

    return collected.filter((message) => messageIsWithinLookback(message, lookbackStartMs));
  });

  const postTeamsWebhookAck = Effect.fn("runTeamsModule.postTeamsWebhookAck")(function* (
    channel: TeamsChannelConfig,
    message: TeamsMessage,
  ) {
    if (!channel.respondToMentions || !channel.teamsIncomingWebhookUrl) return;
    yield* Effect.tryPromise({
      try: () =>
        globalThis.fetch(channel.teamsIncomingWebhookUrl!, {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          body: JSON.stringify({
            text: `Triage started for ${channel.company}/${channel.environment}: ${truncateTitle(
              buildTeamsIncidentTitle({
                company: channel.company,
                environment: channel.environment,
                message,
              }),
              140,
            )}`,
          }),
        }),
      catch: (cause) => new Error(String(cause)),
    }).pipe(Effect.ignore);
  });

  const openDiscordThread = Effect.fn("runTeamsModule.openDiscordThread")(function* (
    channel: TeamsChannelConfig,
    message: TeamsMessage,
    reason: "mention" | "german-problem" | "allowlisted-reaction" | "internal-tag",
    imageFiles: ReadonlyArray<DiscordUploadFile>,
  ) {
    const discordChannelId = channel.discordChannelId;
    if (discordChannelId === undefined) {
      return yield* Effect.fail(
        new Error(
          `Teams channel ${channel.teamId}/${channel.channelId} uses Discord delivery without discordChannelId.`,
        ),
      );
    }
    const seedContent = buildTeamsSeedMessage({
      company: channel.company,
      environment: channel.environment,
      channelName: channel.channelName,
      message,
      reason,
    });
    const seed =
      imageFiles.length === 0
        ? yield* rest.createMessage(discordChannelId, {
            content: seedContent,
          })
        : yield* Effect.tryPromise({
            try: () =>
              createMessageWithAttachments({
                baseUrl: discordConfig.rest.baseUrl,
                botToken: Redacted.value(discordConfig.token),
                channelId: discordChannelId,
                content: seedContent,
                files: imageFiles,
              }),
            catch: (cause) =>
              cause instanceof DiscordUploadError
                ? cause
                : new DiscordUploadError(cause instanceof Error ? cause.message : String(cause)),
          });
    const discordThread = yield* rest.createThreadFromMessage(discordChannelId, seed.id, {
      name: truncateTitle(
        buildTeamsIncidentTitle({
          company: channel.company,
          environment: channel.environment,
          message,
        }),
      ),
      auto_archive_duration: 1440,
    });
    return discordThread.id;
  });

  const hostedContentsPath = (channel: TeamsChannelConfig, message: TeamsMessage): string =>
    message.replyToId
      ? `/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages/${encodeURIComponent(message.replyToId)}/replies/${encodeURIComponent(message.id)}/hostedContents`
      : `/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages/${encodeURIComponent(message.id)}/hostedContents`;

  const buildHostedContentValueUrl = (
    channel: TeamsChannelConfig,
    message: TeamsMessage,
    hostedContentId: string,
  ): string =>
    `https://graph.microsoft.com/v1.0${
      message.replyToId
        ? `/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages/${encodeURIComponent(message.replyToId)}/replies/${encodeURIComponent(message.id)}/hostedContents/${encodeURIComponent(hostedContentId)}/$value`
        : `/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages/${encodeURIComponent(message.id)}/hostedContents/${encodeURIComponent(hostedContentId)}/$value`
    }`;

  const listHostedContentsForMessage = Effect.fn("runTeamsModule.listHostedContentsForMessage")(
    function* (channel: TeamsChannelConfig, message: TeamsMessage) {
      const response = (yield* graphGetUnknown(hostedContentsPath(channel, message)).pipe(
        Effect.orElseSucceed(() => ({ value: [] }) satisfies GraphHostedContentResponse),
      )) as GraphHostedContentResponse;
      return (response.value ?? [])
        .filter(
          (entry): entry is { readonly id: string; readonly contentType?: string | undefined } =>
            typeof entry.id === "string" && entry.id.length > 0,
        )
        .map((entry) => ({
          id: entry.id,
          contentType: entry.contentType,
          valueUrl: buildHostedContentValueUrl(channel, message, entry.id),
        }));
    },
  );

  const recentHistoryForMessage = (
    channel: TeamsChannelConfig,
    messages: ReadonlyArray<TeamsMessage>,
    targetMessage: TeamsMessage,
    processedRootKeys: ReadonlySet<string>,
  ): ReadonlyArray<TeamsMessage> => {
    const targetIndex = messages.findIndex((message) => message.id === targetMessage.id);
    if (targetIndex <= 0) return [];

    const targetTime = Date.parse(targetMessage.createdDateTime ?? "");
    const history: TeamsMessage[] = [];
    for (let index = targetIndex - 1; index >= 0; index -= 1) {
      const candidate = messages[index]!;
      if (!isHumanTeamsMessage(candidate)) continue;
      if (processedRootKeys.has(sourceThreadKey(channel, rootTeamsMessageId(candidate)))) break;
      const candidateTime = Date.parse(candidate.createdDateTime ?? "");
      if (
        Number.isFinite(targetTime) &&
        Number.isFinite(candidateTime) &&
        targetTime - candidateTime > 2 * 60 * 60 * 1000
      ) {
        break;
      }
      history.push(candidate);
    }

    return history.toReversed();
  };

  const processedRootKeysForChannel = Effect.fn("runTeamsModule.processedRootKeysForChannel")(
    function* (channel: TeamsChannelConfig) {
      const prefix = `${channel.teamId}/${channel.channelId}/`;
      const allLinks = yield* links.list();
      return new Set(
        allLinks
          .filter((link) => (link.sourceKind ?? "discord") === "teams")
          .map((link) => link.sourceThreadId)
          .filter(
            (value): value is string => typeof value === "string" && value.startsWith(prefix),
          ),
      );
    },
  );

  const findMessageById = (
    messages: ReadonlyArray<TeamsMessage>,
    messageId: string | null | undefined,
  ): TeamsMessage | null =>
    typeof messageId === "string"
      ? (messages.find((message) => message.id === messageId) ?? null)
      : null;

  const resolveTagTargetMessage = (
    message: TeamsMessage,
    messages: ReadonlyArray<TeamsMessage>,
  ): TeamsMessage => findMessageById(messages, message.replyToId) ?? message;

  type TriggerReason = "mention" | "german-problem" | "allowlisted-reaction" | "internal-tag";

  const classifyTrigger = (input: {
    readonly channel: TeamsChannelConfig;
    readonly message: TeamsMessage;
    readonly messages: ReadonlyArray<TeamsMessage>;
    readonly alreadySeen: boolean;
  }): {
    readonly reason: TriggerReason;
    readonly targetMessage: TeamsMessage;
    readonly triggerMessage?: TeamsMessage | undefined;
  } | null => {
    const mentionTrigger =
      !input.alreadySeen && mentionsTeamsBot(input.message, config.teamsBotDisplayName);
    if (mentionTrigger) {
      return {
        reason: "mention",
        targetMessage: input.message,
      };
    }

    const reactionTrigger = hasAllowlistedReaction({
      message: input.message,
      allowlistedUserIds: input.channel.internalUserIds,
      reactionTriggerTypes: input.channel.reactionTriggerTypes,
    });
    if (reactionTrigger) {
      return {
        reason: "allowlisted-reaction",
        targetMessage: input.message,
      };
    }

    const tagTrigger =
      !input.alreadySeen &&
      hasInternalTagTrigger({
        message: input.message,
        allowlistedUserIds: input.channel.internalUserIds,
        messageTagTriggers: input.channel.messageTagTriggers,
      });
    if (tagTrigger) {
      return {
        reason: "internal-tag",
        targetMessage: resolveTagTargetMessage(input.message, input.messages),
        triggerMessage: input.message,
      };
    }

    const automaticAssessmentEnabled = input.channel.automaticAssessmentEnabled ?? true;
    const germanProblemTrigger =
      automaticAssessmentEnabled &&
      !input.alreadySeen &&
      looksLikeGermanProblemReport({
        message: input.message,
        companyKeywords: input.channel.companyKeywords,
        environmentKeywords: input.channel.environmentKeywords,
        problemKeywords: input.channel.problemKeywords,
      });
    if (germanProblemTrigger) {
      return {
        reason: "german-problem",
        targetMessage: input.message,
      };
    }

    return null;
  };

  const processMessage = Effect.fn("runTeamsModule.processMessage")(function* (
    channel: TeamsChannelConfig,
    message: TeamsMessage,
    messages: ReadonlyArray<TeamsMessage>,
    seenIds: Set<string>,
    processedRootKeys: Set<string>,
  ) {
    if (!isHumanTeamsMessage(message)) return;

    const alreadySeen = seenIds.has(message.id);
    const trigger = classifyTrigger({
      channel,
      message,
      messages,
      alreadySeen,
    });

    if (!alreadySeen) {
      yield* seenStore.markSeen(channelKey(channel), message.id);
      seenIds.add(message.id);
    }

    if (trigger === null) return;

    const rootMessageId = rootTeamsMessageId(trigger.targetMessage);
    const rootKey = sourceThreadKey(channel, rootMessageId);
    if (processedRootKeys.has(rootKey)) return;

    const accessToken = yield* getAccessToken();
    const hostedContents = yield* listHostedContentsForMessage(channel, trigger.targetMessage);
    const imageDownloads = yield* Effect.tryPromise({
      try: () =>
        downloadTeamsMessageImages({
          message: trigger.targetMessage,
          accessToken,
          hostedContentEntries: hostedContents,
        }),
      catch: (cause) => new Error(String(cause)),
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Failed to download Teams image attachments", {
          error: String(error),
        }).pipe(
          Effect.as({
            discordFiles: [] as ReadonlyArray<DiscordUploadFile>,
            t3Uploads: [],
            skipped: [],
          }),
        ),
      ),
    );
    if (imageDownloads.skipped.length > 0) {
      yield* Effect.logWarning("Skipped some Teams image attachments", {
        skipped: imageDownloads.skipped,
      });
    }

    const history = recentHistoryForMessage(
      channel,
      messages,
      trigger.targetMessage,
      processedRootKeys,
    );

    const prompt = buildTeamsPrompt({
      channelName: channel.channelName,
      company: channel.company,
      environment: channel.environment,
      projectShortName: channel.projectShortName,
      reason: trigger.reason,
      message: trigger.targetMessage,
      triggerMessage: trigger.triggerMessage,
      history,
    });
    if (channel.deliveryMode === "discord") {
      const discordChannelId = channel.discordChannelId;
      if (discordChannelId === undefined) {
        return yield* Effect.fail(
          new Error(
            `Teams channel ${channel.teamId}/${channel.channelId} uses Discord delivery without discordChannelId.`,
          ),
        );
      }
      const existing = yield* links.getBySourceThread("teams", rootKey);
      const discordThreadId =
        existing?.discordThreadId ??
        (yield* openDiscordThread(
          channel,
          trigger.targetMessage,
          trigger.reason,
          imageDownloads.discordFiles,
        ));
      yield* startOrContinueLinkedTurn(config, {
        source: {
          sourceKind: "teams",
          sourceThreadId: rootKey,
        },
        discordThreadId,
        discordParentChannelId: discordChannelId,
        discordGuildId: "",
        projectShortName: channel.projectShortName,
        prompt,
        flags: {},
        ...(imageDownloads.t3Uploads.length > 0 ? { attachments: imageDownloads.t3Uploads } : {}),
        announceLines: [
          `Linked **${channel.projectShortName}**`,
          `Source: Teams / ${channel.channelName}`,
          `Company: **${channel.company}**`,
          `Environment: **${channel.environment}**`,
        ],
        promptContext: {
          kind: "raw",
          value: prompt,
        },
      });
    } else {
      yield* startOrContinueT3Turn(config, {
        source: {
          sourceKind: "teams",
          sourceThreadId: rootKey,
        },
        externalConversationId: rootKey,
        externalParentId: `${channel.teamId}/${channel.channelId}`,
        externalTenantId: config.teamsTenantId ?? "",
        projectShortName: channel.projectShortName,
        prompt,
        flags: {},
        ...(imageDownloads.t3Uploads.length > 0 ? { attachments: imageDownloads.t3Uploads } : {}),
        promptContext: {
          kind: "raw",
          value: prompt,
        },
      });
    }
    processedRootKeys.add(rootKey);

    if (trigger.reason === "mention" || channel.deliveryMode !== "discord") {
      yield* postTeamsWebhookAck(channel, trigger.targetMessage);
    }
  });

  const listMessagesForChannel = Effect.fn("runTeamsModule.listMessagesForChannel")(function* (
    channel: TeamsChannelConfig,
  ) {
    const lookbackStartMs = nowLookbackStart().getTime();
    const roots = yield* listPagedMessages(
      `/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages?$top=50`,
      lookbackStartMs,
    );

    const collected: TeamsMessage[] = [];
    for (const root of roots) {
      collected.push(root);
      const replies = yield* listPagedMessages(
        `/teams/${encodeURIComponent(channel.teamId)}/channels/${encodeURIComponent(channel.channelId)}/messages/${encodeURIComponent(root.id)}/replies?$top=50`,
        lookbackStartMs,
      ).pipe(Effect.orElseSucceed(() => [] as TeamsMessage[]));
      collected.push(...replies);
    }

    return collected.toSorted((left, right) =>
      teamsMessageTimestamp(left).localeCompare(teamsMessageTimestamp(right)),
    );
  });

  yield* Effect.logInfo("Teams module enabled", {
    channels: channels.length,
    pollIntervalSeconds: config.teamsPollIntervalSeconds,
  });

  while (true) {
    for (const channel of channels) {
      yield* Effect.gen(function* () {
        const messages = yield* listMessagesForChannel(channel);
        const seenIds = new Set(yield* seenStore.listSeenIds(channelKey(channel)));
        const processedRootKeys = yield* processedRootKeysForChannel(channel);
        for (const message of messages) {
          yield* processMessage(channel, message, messages, seenIds, processedRootKeys);
        }
      }).pipe(
        Effect.catch((error) =>
          Effect.logError("Teams channel poll failed", {
            teamId: channel.teamId,
            channelId: channel.channelId,
            error: String(error),
          }),
        ),
      );
    }

    yield* Effect.sleep(Duration.seconds(config.teamsPollIntervalSeconds));
  }
});
