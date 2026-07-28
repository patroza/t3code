// @effect-diagnostics anyUnknownInErrorContext:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off globalPromise:off missingEffectContext:off tryCatchInEffectGen:off preferSchemaOverJson:off
import { App } from "@microsoft/teams.apps";
import { ProviderUserInputAnswers, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DiscordBotConfig } from "../config.ts";
import { derivePendingInteractions } from "../presentation/pendingInteractions.ts";
import { ProjectAliasStore } from "../projectAliases.ts";
import { ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { T3Session } from "../t3/T3Session.ts";
import { loadTeamsChannelConfigsFromFileSync, type TeamsChannelConfig } from "../teams/config.ts";
import { teamsMessageText } from "../teams/presentation.ts";
import { startOrContinueT3Turn } from "./LinkedTurnRouter.ts";
import { finalAnswerText } from "./ResponseBridge.ts";

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

function settled(status: string | null | undefined): boolean {
  return status !== "starting" && status !== "running";
}

export function splitTeamsMessage(text: string): ReadonlyArray<string> {
  const normalized = text.trim();
  if (normalized.length <= 25_000) return [normalized];
  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > 25_000) {
    const candidate = remaining.slice(0, 25_000);
    const splitAt = Math.max(candidate.lastIndexOf("\n\n"), candidate.lastIndexOf("\n"));
    const end = splitAt >= 10_000 ? splitAt : 25_000;
    chunks.push(remaining.slice(0, end).trimEnd());
    remaining = remaining.slice(end).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

const waitForFinalAnswer = Effect.fn("waitForFinalAnswer")(function* (input: {
  readonly t3ThreadId: ThreadId;
  readonly baseline: string;
  readonly baselineTurnId: string | null;
  readonly send: (text: string) => Promise<unknown>;
}) {
  const t3 = yield* T3Session;
  const announcedRequests = new Set<string>();
  while (true) {
    yield* Effect.sleep("1 second");
    const snapshot = yield* t3.fetchThreadDetail(input.t3ThreadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Teams final-answer poll failed", {
          threadId: input.t3ThreadId,
          error: String(error),
        }).pipe(Effect.as(null)),
      ),
    );
    if (snapshot === null) continue;
    for (const interaction of derivePendingInteractions(snapshot.thread.activities)) {
      if (announcedRequests.has(interaction.requestId)) continue;
      announcedRequests.add(interaction.requestId);
      if (interaction.kind === "approval") {
        yield* Effect.tryPromise({
          try: () =>
            input.send(
              [
                `T3 needs **${interaction.requestKind}** approval.`,
                interaction.detail,
                `Reply \`approve ${interaction.requestId}\` or \`deny ${interaction.requestId}\`.`,
              ]
                .filter((line): line is string => line !== null)
                .join("\n\n"),
            ),
          catch: (cause) => new Error(String(cause)),
        });
      } else {
        const questions = interaction.questions
          .map(
            (question) =>
              `- \`${question.id}\`: ${question.question}${
                question.options.length === 0
                  ? ""
                  : ` (${question.options.map((option) => option.label).join(", ")})`
              }`,
          )
          .join("\n");
        yield* Effect.tryPromise({
          try: () =>
            input.send(
              [
                "T3 needs more information:",
                questions,
                `Reply \`answer ${interaction.requestId} {"question-id":"answer"}\`.`,
              ].join("\n\n"),
            ),
          catch: (cause) => new Error(String(cause)),
        });
      }
    }
    const answer = finalAnswerText(snapshot.thread);
    const latestTurnId = snapshot.thread.latestTurn?.turnId ?? null;
    if (
      answer.length === 0 ||
      (answer === input.baseline && latestTurnId === input.baselineTurnId) ||
      !settled(snapshot.thread.session?.status)
    ) {
      continue;
    }
    for (const chunk of splitTeamsMessage(answer)) {
      yield* Effect.tryPromise({
        try: () => input.send(chunk),
        catch: (cause) => new Error(String(cause)),
      });
    }
    return;
  }
});

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

/**
 * Native Teams SDK endpoint. This is independent from Discord gateway/services and can be
 * deployed with only Teams + T3 credentials.
 */
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
  const t3 = yield* T3Session;
  const links = yield* ThreadLinkStore;
  const services = yield* Effect.context<ProjectAliasStore | T3Session | ThreadLinkStore>();
  const run = Effect.runPromiseWith(services);

  const app = new App({
    clientId: config.teamsClientId,
    clientSecret: config.teamsClientSecret,
    tenantId: config.teamsTenantId,
    messagingEndpoint: config.teamsMessagingEndpoint,
    activity: { mentions: { stripText: true } },
  });

  app.on("message", async ({ activity, send, reply }) => {
    await run(
      Effect.gen(function* () {
        const location = coordinates(activity);
        const sourceKey = sourceConversationKey(location);
        const channel = channelForCoordinates(channels, location);
        const projectShortName = channel?.projectShortName ?? config.teamsDefaultProjectShortName;
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

        const baselineSnapshot =
          existing === null
            ? null
            : yield* t3
                .fetchThreadDetail(existing.t3ThreadId)
                .pipe(Effect.orElseSucceed(() => null));
        const baseline = baselineSnapshot === null ? "" : finalAnswerText(baselineSnapshot.thread);
        const baselineTurnId = baselineSnapshot?.thread.latestTurn?.turnId ?? null;
        const turn = yield* startOrContinueT3Turn(config, {
          source: { sourceKind: "teams", sourceThreadId: sourceKey },
          externalConversationId: location.conversationId,
          externalParentId: `${location.teamId ?? "chat"}/${location.channelId ?? "chat"}`,
          externalTenantId: location.tenantId,
          projectShortName,
          prompt,
          flags: {},
          stickyModelOnContinue: true,
          promptContext: { kind: "raw", value: prompt },
        });

        const webLink =
          config.webUiBaseUrl === undefined
            ? null
            : `${config.webUiBaseUrl.replace(/\/$/u, "")}/?thread=${turn.threadId}`;
        yield* Effect.promise(() =>
          reply(
            [
              turn.isNew
                ? `Started T3 for **${projectShortName}**.`
                : "Continued the linked T3 thread.",
              webLink === null ? null : `[Open in T3 Code](${webLink})`,
            ]
              .filter((line): line is string => line !== null)
              .join("\n"),
          ),
        );
        yield* Effect.forkDetach(
          waitForFinalAnswer({
            t3ThreadId: turn.threadId,
            baseline,
            baselineTurnId,
            send: (text) => send(text),
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logError("Native Teams answer delivery failed", {
                threadId: turn.threadId,
                cause,
              }),
            ),
          ),
        );
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
    const data = activity.value.data as
      | { readonly projectShortName?: unknown; readonly instructions?: unknown }
      | undefined;
    const projectShortName =
      typeof data?.projectShortName === "string" ? data.projectShortName.trim() : "";
    if (projectShortName.length === 0) {
      return { task: { type: "message", value: "A project alias is required." } };
    }
    const sourceMessage = teamsMessageText({
      id: activity.value.messagePayload?.id ?? activity.id,
      body: activity.value.messagePayload?.body,
      from: activity.value.messagePayload?.from,
    });
    const instructions = typeof data?.instructions === "string" ? data.instructions.trim() : "";
    const prompt = [
      "Investigate the following Microsoft Teams message.",
      sourceMessage,
      instructions.length === 0 ? null : `Additional instructions: ${instructions}`,
    ]
      .filter((line): line is string => line !== null && line.length > 0)
      .join("\n\n");
    const location = coordinates(activity);
    const messageId = activity.value.messagePayload?.id ?? activity.id;
    const sourceKey = `message-action/${location.tenantId}/${messageId}`;

    Effect.runForkWith(services)(
      startOrContinueT3Turn(config, {
        source: { sourceKind: "teams", sourceThreadId: sourceKey },
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
