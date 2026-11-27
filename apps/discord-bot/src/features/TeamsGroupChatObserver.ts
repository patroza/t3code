// @effect-diagnostics anyUnknownInErrorContext:off globalErrorInEffectCatch:off missingEffectContext:off
import {
  ProviderUserInputAnswers,
  type ThreadId,
  type UploadChatAttachment,
} from "@t3tools/contracts";
import type * as Context from "effect/Context";
import { DiscordREST } from "dfx";
import * as Cause from "effect/Cause";
import * as Context_ from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

import type { DiscordBotConfig } from "../config.ts";
import { classifyTeamsAgentAccess, type PersonIdentity } from "../identityMap.ts";
import { formatOpenInOmegentLink } from "../presentation/threadInfoPin.ts";
import { ThreadLinkStore, type ThreadLink } from "../store/ThreadLinkStore.ts";
import { T3Session } from "../t3/T3Session.ts";
import type { TeamsMessageContext } from "../teams/messageEvents.ts";
import {
  groupChatChannelSeed,
  groupChatDiscordThreadsFile,
  groupChatLogLine,
  groupChatMirrorsFile,
  planTeamsGroupChat,
  groupChatThreadName,
  readGroupChatMirror,
  rememberGroupChatMirror,
  teamsChannelThreadId,
  type GroupChatCommand,
  type GroupChatMirror,
  type GroupChatPlan,
  type GroupChatRule,
} from "../teams/groupChats.ts";
import { weeklyThreadKey } from "../teams/weeklyThreads.ts";
import { formatOmegentLinkMarker } from "./linkMarker.ts";
import { startOrContinueT3Turn } from "./LinkedTurnRouter.ts";

const decodeGroupChatAnswers = Schema.decodeEffect(Schema.fromJsonString(ProviderUserInputAnswers));

interface TeamsGroupChatActivity {
  readonly event: "message" | "join";
  readonly tenantId: string;
  readonly conversationId: string;
  readonly conversationType?: unknown;
  readonly isGroup?: boolean | undefined;
  readonly teamId?: string | undefined;
  readonly title?: string | undefined;
  readonly text: string;
  readonly messageId?: string | undefined;
  readonly author?: string | undefined;
  readonly authorAadObjectId?: string | undefined;
  readonly authorUserId?: string | undefined;
  readonly fromBot: boolean;
  readonly mentionedBot: boolean;
}

function discordRest(runtime: Context.Context<never>) {
  return Option.getOrNull(Context_.getOption(runtime, DiscordREST));
}

function useRuntime<A, E, R>(
  runtime: Context.Context<never>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E> {
  return effect.pipe(Effect.provideContext(runtime as Context.Context<R>)) as Effect.Effect<A, E>;
}

/**
 * Link key until the weekly chat has a Discord thread. Links are keyed by Discord thread id,
 * so this keeps the T3 thread linked while Discord is down. It never reaches Discord REST.
 */
export function groupChatPlaceholderThreadId(sourceKey: string): string {
  return `teams-group:${sourceKey}`;
}

// Anything but a snowflake (the placeholder, or a Teams mirror id if a mirror mention
// created the link first) is not a Discord thread yet.
function isPlaceholderThreadId(discordThreadId: string): boolean {
  return !/^\d+$/u.test(discordThreadId);
}

function openAlertThread(
  runtime: Context.Context<never>,
  rest: NonNullable<ReturnType<typeof discordRest>>,
  channelId: string,
  chat: Extract<GroupChatPlan, { kind: "turn" }>["chat"],
) {
  return useRuntime(
    runtime,
    Effect.gen(function* () {
      const seed = yield* rest.createMessage(channelId, {
        content: [
          `**${chat.title}**`,
          `Passive Teams group chat, mapped to **${chat.projectShortName}**.`,
          "Omegent stays silent in that chat. This thread is the observation log.",
        ].join("\n"),
      });
      const thread = yield* rest.createThreadFromMessage(channelId, seed.id, {
        name: groupChatThreadName(chat.title),
        auto_archive_duration: 1440,
      });
      return thread.id;
    }),
  );
}

function postDiscord(runtime: Context.Context<never>, channelId: string, content: string) {
  const rest = discordRest(runtime);
  if (rest === null || isPlaceholderThreadId(channelId)) return Effect.void;
  return useRuntime(runtime, rest.createMessage(channelId, { content })).pipe(
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Effect.logError("Could not post to the Discord group chat thread", {
        discordThreadId: channelId,
        cause: Cause.pretty(cause),
      }),
    ),
  );
}

/** Real Discord thread for this week's chat: the link's, else one opened before T3 failed. */
function knownAlertThread(threadsFile: string, sourceKey: string, existing: ThreadLink | null) {
  if (existing !== null && !isPlaceholderThreadId(existing.discordThreadId)) {
    return existing.discordThreadId;
  }
  return readGroupChatMirror(threadsFile, sourceKey);
}

const ensureAlertThread = Effect.fn("ensureAlertThread")(function* (
  runtime: Context.Context<never>,
  config: DiscordBotConfig,
  sourceKey: string,
  existing: ThreadLink | null,
  chat: Extract<GroupChatPlan, { kind: "turn" }>["chat"],
) {
  const threadsFile = groupChatDiscordThreadsFile(config.dataDir);
  const known = knownAlertThread(threadsFile, sourceKey, existing);
  if (known !== null) return known;
  const rest = discordRest(runtime);
  if (rest === null) {
    yield* Effect.logError("Discord is unavailable; the Teams group chat continues without it", {
      sourceKey,
    });
    return null;
  }
  const alertsChannelId = config.alertsChannelId;
  if (alertsChannelId === undefined || alertsChannelId.length === 0) {
    yield* Effect.logError(
      "DISCORD_ALERTS_CHANNEL_ID is unset; the Teams group chat continues without Discord",
      { sourceKey },
    );
    return null;
  }
  const opened = yield* openAlertThread(runtime, rest, alertsChannelId, chat).pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Could not open the Discord group chat thread", {
        sourceKey,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(null)),
    ),
  );
  if (opened === null) return null;
  yield* Effect.tryPromise({
    try: () => rememberGroupChatMirror(threadsFile, sourceKey, opened),
    catch: (error: unknown) => String(error),
  }).pipe(
    Effect.catch((error) =>
      Effect.logError("Could not remember the Discord group chat thread", { sourceKey, error }),
    ),
  );
  return opened;
});

/**
 * Point the weekly link at its Discord thread and post the link message once. The guest
 * Discord bot adopts the thread from the marker line and streams T3 output there.
 * The marker message id is stored as the link's info message, which marks it posted.
 */
const attachAlertThread = Effect.fn("attachAlertThread")(function* (
  runtime: Context.Context<never>,
  config: DiscordBotConfig,
  sourceKey: string,
  discordThreadId: string,
  chat: Extract<GroupChatPlan, { kind: "turn" }>["chat"],
) {
  const links = yield* ThreadLinkStore;
  const rest = discordRest(runtime);
  const link = yield* links.getBySourceThread("teams", sourceKey);
  if (rest === null || link === null) return;
  if (link.discordThreadId === discordThreadId && link.infoDiscordMessageId !== undefined) return;
  const webLink =
    config.webUiBaseUrl === undefined
      ? null
      : `${config.webUiBaseUrl.replace(/\/$/u, "")}/?thread=${link.t3ThreadId}`;
  const content = [
    `Linked **${chat.projectShortName}**`,
    `Source: Teams group chat / ${chat.title}`,
    "Omegent stays silent in that chat.",
    ...(webLink === null ? [] : [formatOpenInOmegentLink(webLink)]),
    formatOmegentLinkMarker({
      t3ThreadId: link.t3ThreadId,
      projectShortName: chat.projectShortName,
      sourceKind: "teams",
      sourceThreadId: sourceKey,
    }),
  ].join("\n");
  const posted = yield* useRuntime(runtime, rest.createMessage(discordThreadId, { content })).pipe(
    Effect.map((message) => message.id as string),
    Effect.catchCause((cause) =>
      Effect.logError("Could not post the Omegent link to the Discord group chat thread", {
        sourceKey,
        discordThreadId,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(null)),
    ),
  );
  // Left as is, the next message retries the attach.
  if (posted === null) return;
  if (link.discordThreadId !== discordThreadId) {
    yield* links.rekey(link.discordThreadId, {
      discordThreadId,
      ...(config.alertsChannelId === undefined ? {} : { channelId: config.alertsChannelId }),
    });
  }
  yield* links.setInfoDiscordMessageId(discordThreadId, posted);
});

export interface TeamsChannelPoster {
  openThread(input: {
    readonly mirror: GroupChatMirror;
    readonly text: string;
  }): Promise<{ readonly id: string; readonly activityId?: string | undefined }>;
  reply(conversationId: string, text: string): Promise<void>;
}

export function teamsChannelPoster(api: TeamsMessageContext["api"]): TeamsChannelPoster {
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

const copyToChannelThread = Effect.fn("copyToChannelThread")(function* (
  poster: TeamsChannelPoster | null,
  filePath: string,
  sourceKey: string,
  mirror: GroupChatMirror | null,
  chat: { readonly title: string; readonly projectShortName: string },
  text: string | null,
) {
  if (poster === null || mirror === null) return { created: false, conversationId: null };
  const savedId = readGroupChatMirror(filePath, sourceKey);
  const openedId =
    savedId ??
    (yield* Effect.tryPromise({
      try: () => poster.openThread({ mirror, text: groupChatChannelSeed(chat) }),
      catch: (error: unknown) => String(error),
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Could not open the Teams channel thread", { error }).pipe(Effect.as(null)),
      ),
      Effect.map((opened) => (opened === null ? null : teamsChannelThreadId(mirror, opened))),
    ));
  if (openedId === null) return { created: false, conversationId: null };
  if (savedId === null) {
    const remembered = yield* Effect.tryPromise({
      try: () => rememberGroupChatMirror(filePath, sourceKey, openedId),
      catch: (error: unknown) => String(error),
    }).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logError("Could not remember the Teams channel thread", { error }).pipe(
          Effect.as(false),
        ),
      ),
    );
    if (!remembered) return { created: false, conversationId: null };
  }
  if (text !== null) {
    yield* Effect.tryPromise({
      try: () => poster.reply(openedId, text),
      catch: (error: unknown) => String(error),
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Could not post to the Teams channel thread", { error }).pipe(
          Effect.asVoid,
        ),
      ),
    );
  }
  return { created: savedId === null, conversationId: openedId };
});

const runGroupChatCommand = Effect.fn("runGroupChatCommand")(function* (
  runtime: Context.Context<never>,
  discordThreadId: string,
  t3ThreadId: ThreadId,
  command: GroupChatCommand,
) {
  if (command.kind === "answer") {
    const requestId = command.requestId;
    const answersJson = command.json;
    yield* useRuntime(
      runtime,
      Effect.gen(function* () {
        const t3 = yield* T3Session;
        const parsed = yield* decodeGroupChatAnswers(answersJson).pipe(
          Effect.catch(() =>
            postDiscord(runtime, discordThreadId, "Answers must be a JSON object.").pipe(
              Effect.as(null),
            ),
          ),
        );
        if (parsed === null) return;
        yield* t3.respondToUserInput(t3ThreadId, requestId, parsed);
        yield* postDiscord(runtime, discordThreadId, "Submitted the requested input to T3.");
      }),
    );
    return;
  }
  if (command.kind === "stop") {
    yield* useRuntime(
      runtime,
      Effect.gen(function* () {
        const t3 = yield* T3Session;
        yield* t3.interrupt(t3ThreadId);
        yield* postDiscord(runtime, discordThreadId, "Stopped the active T3 turn.");
      }),
    );
    return;
  }
  const requestId = command.requestId;
  const decision = command.kind === "approve" ? "accept" : "decline";
  const posted = command.kind === "approve" ? "Approval approved." : "Approval denied.";
  yield* useRuntime(
    runtime,
    Effect.gen(function* () {
      const t3 = yield* T3Session;
      yield* t3.respondToApproval(t3ThreadId, requestId, decision);
      yield* postDiscord(runtime, discordThreadId, posted);
    }),
  );
});

/**
 * Observe a Teams group chat without sending anything back to it.
 * One T3 thread, one Discord alerts thread, and one internal Teams channel thread per week.
 */
/** About three minutes in total: covers a gateway restart and short T3 disconnects. */
const GROUP_CHAT_T3_RETRY = Schedule.max([
  Schedule.min([Schedule.exponential("2 seconds"), Schedule.spaced("1 minute")]),
  Schedule.recurs(7),
]);

export const ingestTeamsGroupChat = Effect.fn("ingestTeamsGroupChat")(function* (
  config: DiscordBotConfig,
  rules: ReadonlyArray<GroupChatRule>,
  people: ReadonlyArray<PersonIdentity>,
  runtime: Context.Context<never>,
  activity: TeamsGroupChatActivity,
  poster: TeamsChannelPoster | null,
  options?: {
    readonly builtinScanner?: boolean;
    readonly builtinMirror?: GroupChatMirror;
    readonly hasImages?: boolean;
    readonly attachments?: ReadonlyArray<UploadChatAttachment>;
    readonly attachmentNote?: string;
    readonly t3RetrySchedule?: Schedule.Schedule<unknown, unknown>;
  },
) {
  const access =
    activity.event === "join"
      ? null
      : classifyTeamsAgentAccess({
          people,
          aadObjectId: activity.authorAadObjectId,
          userId: activity.authorUserId,
          displayName: activity.author,
        });
  const plan = planTeamsGroupChat({
    conversationType: activity.conversationType,
    isGroup: activity.isGroup,
    teamId: activity.teamId,
    tenantId: activity.tenantId,
    conversationId: activity.conversationId,
    title: activity.title,
    rules,
    event: activity.event,
    text: activity.text,
    fromBot: activity.fromBot,
    knownUser: access?.allowed === true,
    mentionedBot: activity.mentionedBot,
    ...(options?.builtinScanner === undefined ? {} : { builtinScanner: options.builtinScanner }),
    ...(options?.builtinMirror === undefined ? {} : { builtinMirror: options.builtinMirror }),
    ...(activity.messageId === undefined ? {} : { messageId: activity.messageId }),
    ...(activity.author === undefined ? {} : { author: activity.author }),
    ...(options?.hasImages === true ? { hasImages: true } : {}),
  });
  if (plan.kind === "not-group") return { handled: false as const };
  if (plan.kind === "skip") return { handled: true as const };
  if (plan.kind === "unmapped") {
    if (activity.event === "join") {
      yield* Effect.logInfo("Ignored unmapped Teams group chat", {
        conversationId: activity.conversationId,
        title: activity.title ?? null,
      });
    }
    return { handled: true as const };
  }

  // Group chats have no reply chains, so the whole chat starts a fresh thread each week.
  const sourceKey = weeklyThreadKey(plan.sourceKey, DateTime.toDateUtc(yield* DateTime.now));
  const links = yield* ThreadLinkStore;
  const existing = yield* links.getBySourceThread("teams", sourceKey);
  const mirrorsFile = groupChatMirrorsFile(config.dataDir);
  // Teams mirror failures are logged and never stop Discord or T3 (and the reverse).
  const copyToMirror = (text: string | null) =>
    copyToChannelThread(poster, mirrorsFile, sourceKey, plan.chat.mirror, plan.chat, text).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Could not copy to the Teams channel thread", {
          sourceKey,
          cause: Cause.pretty(cause),
        }).pipe(Effect.as({ created: false, conversationId: null })),
      ),
    );
  if (plan.kind === "ignore") {
    if (existing !== null) {
      const line = groupChatLogLine(activity.author ?? "unknown", activity.text);
      const alertThread = knownAlertThread(
        groupChatDiscordThreadsFile(config.dataDir),
        sourceKey,
        existing,
      );
      if (alertThread !== null) yield* postDiscord(runtime, alertThread, line);
      yield* copyToMirror(line);
    }
    return { handled: true as const };
  }
  if (plan.kind === "command") {
    if (existing === null) {
      yield* Effect.logInfo("Ignored Teams group chat command before the chat thread exists", {
        sourceKey,
        command: plan.command.kind,
      });
      return { handled: true as const };
    }
    yield* runGroupChatCommand(
      runtime,
      existing.discordThreadId,
      existing.t3ThreadId,
      plan.command,
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Teams group chat command failed", {
          sourceKey,
          command: plan.command.kind,
          cause: Cause.pretty(cause),
        }),
      ),
    );
    yield* copyToMirror(groupChatLogLine(activity.author ?? "unknown", activity.text));
    return { handled: true as const };
  }
  if (plan.wake === "joined" && existing !== null) return { handled: true as const };

  const discordThreadId = yield* ensureAlertThread(runtime, config, sourceKey, existing, plan.chat);
  const observation =
    plan.wake === "joined" ? null : groupChatLogLine(activity.author ?? "unknown", activity.text);
  if (discordThreadId !== null && observation !== null) {
    yield* postDiscord(runtime, discordThreadId, observation);
  }
  const channelThread = yield* copyToMirror(observation);

  const knownPerson = access?.allowed === true ? access.person : null;
  const attachmentNote = options?.attachmentNote?.trim() ?? "";
  const prompt = attachmentNote.length === 0 ? plan.prompt : `${plan.prompt}\n\n${attachmentNote}`;
  // The gateway does not bridge output to Discord: the guest Discord bot adopts the thread
  // from the link marker and owns its output, so nothing is posted twice.
  const turn = yield* useRuntime(
    runtime,
    startOrContinueT3Turn(config, {
      source: { sourceKind: "teams", sourceThreadId: sourceKey },
      ...(knownPerson === null || plan.wake !== "instruction"
        ? {}
        : {
            sourceActor: {
              platformId: activity.authorAadObjectId ?? activity.authorUserId ?? knownPerson.name,
              displayName: knownPerson.name,
            },
          }),
      externalConversationId: existing?.discordThreadId ?? groupChatPlaceholderThreadId(sourceKey),
      externalParentId: existing?.channelId ?? "",
      externalTenantId: existing?.guildId ?? "",
      projectShortName: plan.chat.projectShortName,
      prompt,
      flags: {},
      stickyModelOnContinue: true,
      ...(options?.attachments !== undefined && options.attachments.length > 0
        ? { attachments: options.attachments }
        : {}),
      promptContext: { kind: "raw", value: prompt },
    }),
  ).pipe(
    // T3 drops briefly and is not ready right after a gateway restart; retry rather than lose
    // the message, because the intake claim and Graph last-seen already moved past it.
    Effect.tapCause((cause) =>
      Effect.logWarning("T3 turn for the Teams group chat failed; retrying", {
        sourceKey,
        cause: Cause.pretty(cause),
      }),
    ),
    Effect.retry(options?.t3RetrySchedule ?? GROUP_CHAT_T3_RETRY),
    Effect.catchCause((cause) =>
      Effect.logError("Could not start the T3 turn for the Teams group chat", {
        sourceKey,
        cause: Cause.pretty(cause),
      }).pipe(Effect.as(null)),
    ),
  );
  if (turn === null) return { handled: true as const };
  const t3ThreadId = turn.threadId;
  if (discordThreadId !== null) {
    yield* attachAlertThread(runtime, config, sourceKey, discordThreadId, plan.chat);
  }
  const webBase = config.publicWebUiBaseUrl ?? config.webUiBaseUrl;
  if (
    channelThread.created &&
    channelThread.conversationId !== null &&
    webBase !== undefined &&
    poster !== null
  ) {
    const conversationId = channelThread.conversationId;
    const link = `${webBase.replace(/\/$/u, "")}/?thread=${t3ThreadId}`;
    yield* Effect.tryPromise({
      try: () => poster.reply(conversationId, link),
      catch: (error: unknown) => String(error),
    }).pipe(
      Effect.catch((error) =>
        Effect.logError("Could not post the Omegent link to the Teams channel thread", {
          error,
        }).pipe(Effect.asVoid),
      ),
    );
  }
  return { handled: true as const };
});
