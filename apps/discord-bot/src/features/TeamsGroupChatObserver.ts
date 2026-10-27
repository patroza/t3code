// @effect-diagnostics anyUnknownInErrorContext:off globalErrorInEffectCatch:off missingEffectContext:off
import { ProviderUserInputAnswers, type ThreadId } from "@t3tools/contracts";
import type * as Context from "effect/Context";
import { DiscordREST } from "dfx";
import * as Context_ from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { DiscordBotConfig } from "../config.ts";
import { classifyTeamsAgentAccess, type PersonIdentity } from "../identityMap.ts";
import { ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { T3Session } from "../t3/T3Session.ts";
import {
  groupChatLogLine,
  planTeamsGroupChat,
  groupChatThreadName,
  type GroupChatCommand,
  type GroupChatPlan,
  type GroupChatRule,
} from "../teams/groupChats.ts";
import { startOrContinueLinkedTurn } from "./LinkedTurnRouter.ts";

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

function openAlertThread(
  runtime: Context.Context<never>,
  channelId: string,
  chat: Extract<GroupChatPlan, { kind: "turn" }>["chat"],
) {
  const rest = discordRest(runtime);
  if (rest === null) return Effect.void.pipe(Effect.as(""));
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
  if (rest === null) return Effect.void;
  return useRuntime(runtime, rest.createMessage(channelId, { content })).pipe(Effect.asVoid);
}

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
 * One T3 thread and one Discord alerts thread are created for the chat.
 */
export const ingestTeamsGroupChat = Effect.fn("ingestTeamsGroupChat")(function* (
  config: DiscordBotConfig,
  rules: ReadonlyArray<GroupChatRule>,
  people: ReadonlyArray<PersonIdentity>,
  runtime: Context.Context<never>,
  activity: TeamsGroupChatActivity,
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
    ...(activity.messageId === undefined ? {} : { messageId: activity.messageId }),
    ...(activity.author === undefined ? {} : { author: activity.author }),
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

  const links = yield* ThreadLinkStore;
  const existing = yield* links.getBySourceThread("teams", plan.sourceKey);
  if (plan.kind === "ignore") {
    if (existing !== null) {
      yield* postDiscord(
        runtime,
        existing.discordThreadId,
        groupChatLogLine(activity.author ?? "unknown", activity.text),
      );
    }
    return { handled: true as const };
  }
  if (plan.kind === "command") {
    if (existing === null) {
      yield* Effect.logInfo("Ignored Teams group chat command before the chat thread exists", {
        sourceKey: plan.sourceKey,
        command: plan.command.kind,
      });
      return { handled: true as const };
    }
    yield* runGroupChatCommand(
      runtime,
      existing.discordThreadId,
      existing.t3ThreadId,
      plan.command,
    );
    return { handled: true as const };
  }
  if (plan.wake === "joined" && existing !== null) return { handled: true as const };

  if (discordRest(runtime) === null) {
    yield* Effect.logError("Discord is unavailable; passive Teams group chat was not opened", {
      sourceKey: plan.sourceKey,
    });
    return { handled: true as const };
  }
  const alertsChannelId = config.alertsChannelId;
  if (existing === null && (alertsChannelId === undefined || alertsChannelId.length === 0)) {
    yield* Effect.logError(
      "DISCORD_ALERTS_CHANNEL_ID is unset; passive Teams group chat was not opened",
      { sourceKey: plan.sourceKey },
    );
    return { handled: true as const };
  }
  const discordThreadId =
    existing?.discordThreadId ??
    (yield* openAlertThread(runtime, alertsChannelId ?? "", plan.chat));
  if (discordThreadId.length === 0) return { handled: true as const };

  if (plan.wake !== "joined") {
    yield* postDiscord(
      runtime,
      discordThreadId,
      groupChatLogLine(activity.author ?? "unknown", activity.text),
    );
  }

  const knownPerson = access?.allowed === true ? access.person : null;
  yield* useRuntime(
    runtime,
    startOrContinueLinkedTurn(config, {
      source: { sourceKind: "teams", sourceThreadId: plan.sourceKey },
      ...(knownPerson === null || plan.wake !== "instruction"
        ? {}
        : {
            sourceActor: {
              platformId: activity.authorAadObjectId ?? activity.authorUserId ?? knownPerson.name,
              displayName: knownPerson.name,
            },
          }),
      discordThreadId,
      discordParentChannelId: alertsChannelId ?? existing?.channelId ?? discordThreadId,
      discordGuildId: existing?.guildId ?? "",
      projectShortName: plan.chat.projectShortName,
      prompt: plan.prompt,
      flags: {},
      stickyModelOnContinue: true,
      announceLines: [
        `Linked **${plan.chat.projectShortName}**`,
        `Source: Teams group chat / ${plan.chat.title}`,
        "Omegent stays silent in that chat.",
      ],
      promptContext: { kind: "raw", value: plan.prompt },
    }),
  );
  return { handled: true as const };
});
