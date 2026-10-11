// @effect-diagnostics anyUnknownInErrorContext:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off globalPromise:off missingEffectContext:off tryCatchInEffectGen:off preferSchemaOverJson:off
import { App } from "@microsoft/teams.apps";
import { ProviderUserInputAnswers, TurnId, type ThreadId } from "@t3tools/contracts";
import type { IntegrationThreadView } from "@t3tools/shared/integrationThreadView";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { DiscordBotConfig } from "../config.ts";
import { classifyTeamsAgentAccess, IdentityMapStore, type PersonIdentity } from "../identityMap.ts";
import {
  activeTurnWakeNote,
  formatInProgressChunk,
  nextWorkingDotCount,
  stripWorkingIndicator,
  type WorkingDotCount,
} from "../presentation/messages.ts";
import { derivePendingInteractions } from "../presentation/pendingInteractions.ts";
import { countTurnToolCalls } from "../presentation/toolCalls.ts";
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
 * A Teams answer is final only when the T3 turn itself has left `running`.
 * Session status returns to idle between assistant bubbles while tools are still
 * running, and treating that bubble as the answer ends delivery early.
 */
export function teamsTurnSettled(thread: {
  readonly session?: { readonly status?: string | null } | null;
  readonly latestTurn?: { readonly state?: string | null } | null;
}): boolean {
  if (thread.latestTurn?.state === "running") return false;
  if (thread.latestTurn == null) {
    const status = thread.session?.status ?? null;
    if (status === "running" || status === "starting") return false;
    // No turn record yet. Idle or ready is the gap before start, not completion.
    if (status === null || status === "idle" || status === "ready" || status === "") return false;
    return true;
  }
  return true;
}

export function teamsVisibleText(input: {
  readonly preface: string | null;
  readonly body: string;
  readonly inProgress: boolean;
  readonly dotCount?: WorkingDotCount;
  readonly toolCallCount?: number;
  readonly wakeNote?: string | null;
}): string {
  const parts = [input.preface?.trim(), input.body.trim()].filter(
    (part): part is string => part !== undefined && part.length > 0,
  );
  const combined = parts.join("\n\n");
  if (!input.inProgress) return stripWorkingIndicator(combined);
  return formatInProgressChunk(
    combined,
    true,
    12_000,
    input.dotCount ?? 2,
    input.toolCallCount ?? 0,
    input.wakeNote ?? null,
  );
}

/** Provider readiness can occur between tools; completion belongs to the requested run. */
export function teamsRunDelivery(
  thread: IntegrationThreadView,
  messageId: string,
):
  | { readonly kind: "pending" }
  | { readonly kind: "completed"; readonly answer: string }
  | { readonly kind: "failed"; readonly answer: string } {
  const run = thread.runStatuses?.find((item) => item.userMessageId === messageId);
  if (run === undefined) return { kind: "pending" };
  if (["failed", "interrupted", "cancelled", "rolled_back"].includes(run.status)) {
    return {
      kind: "failed",
      answer:
        "This T3 run stopped before completing. Open the linked thread for details or send a new mention.",
    };
  }
  if (run.status !== "completed") return { kind: "pending" };
  const messages = thread.messages.filter((message) => message.turnId === run.id);
  const answer = finalAnswerText({
    ...thread,
    session: null,
    latestTurn: {
      turnId: TurnId.make(run.id),
      state: "completed",
      requestedAt: thread.updatedAt,
      startedAt: null,
      completedAt: thread.updatedAt,
      assistantMessageId: null,
    },
    messages,
  });
  return { kind: "completed", answer };
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

export const waitForFinalAnswer = Effect.fn("waitForFinalAnswer")(function* (input: {
  readonly t3ThreadId: ThreadId;
  readonly messageId?: string;
  readonly baseline: string;
  readonly baselineTurnId: string | null;
  readonly preface?: string | null;
  readonly send: (text: string) => Promise<unknown>;
  /** Side channel for approvals and questions. Never edits the working ack. */
  readonly notify?: (text: string) => Promise<unknown>;
  /** Edit the ack message in place. Absent callers only receive the final answer. */
  readonly replaceProgress?: (text: string) => Promise<unknown>;
  readonly canDeliver?: () => boolean;
}) {
  const t3 = yield* T3Session;
  const announcedRequests = new Set<string>();
  let emptyCompletedPolls = 0;
  let dots: WorkingDotCount = 2;
  let polls = 0;
  let lastProgress = teamsVisibleText({
    preface: input.preface ?? null,
    body: "",
    inProgress: true,
  });
  const post = (text: string) =>
    Effect.tryPromise({
      try: () => input.send(text),
      catch: (cause) => new Error(String(cause)),
    });
  const announce = (text: string) =>
    Effect.tryPromise({
      try: () => (input.notify ?? input.send)(text),
      catch: (cause) => new Error(String(cause)),
    });
  const edit = (text: string) => {
    const replaceProgress = input.replaceProgress;
    if (replaceProgress === undefined) return post(text);
    return Effect.tryPromise({
      try: () => replaceProgress(text),
      catch: (cause) => new Error(String(cause)),
    });
  };
  const publishFinal = (text: string) =>
    Effect.gen(function* () {
      const chunks = splitTeamsMessage(text);
      const [first, ...rest] = chunks;
      if (first !== undefined && input.replaceProgress !== undefined) {
        yield* edit(first).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Teams final update failed; sending a new message", {
              threadId: input.t3ThreadId,
              error: String(error),
            }).pipe(Effect.andThen(post(first))),
          ),
        );
      } else if (first !== undefined) {
        yield* post(first);
      }
      for (const chunk of rest) yield* post(chunk);
    });

  while (true) {
    yield* Effect.sleep("1 second");
    if (input.canDeliver !== undefined && !input.canDeliver()) return;
    const snapshot = yield* t3.fetchThreadDetail(input.t3ThreadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Teams final-answer poll failed", {
          threadId: input.t3ThreadId,
          error: String(error),
        }).pipe(Effect.as(null)),
      ),
    );
    if (snapshot === null) continue;
    const targetRun =
      input.messageId === undefined
        ? undefined
        : snapshot.thread.runStatuses?.find((run) => run.userMessageId === input.messageId);
    if (input.messageId !== undefined && targetRun === undefined) continue;
    const activities =
      targetRun === undefined
        ? snapshot.thread.activities
        : snapshot.thread.activities.filter((activity) => activity.turnId === targetRun.id);
    for (const interaction of derivePendingInteractions(activities)) {
      if (announcedRequests.has(interaction.requestId)) continue;
      announcedRequests.add(interaction.requestId);
      if (interaction.kind === "approval") {
        yield* announce(
          [
            `T3 needs **${interaction.requestKind}** approval.`,
            interaction.detail,
            `Reply \`approve ${interaction.requestId}\` or \`deny ${interaction.requestId}\`.`,
          ]
            .filter((line): line is string => line !== null)
            .join("\n\n"),
        );
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
        yield* announce(
          [
            "T3 needs more information:",
            questions,
            `Reply \`answer ${interaction.requestId} {"question-id":"answer"}\`.`,
          ].join("\n\n"),
        );
      }
    }
    const showProgress = (body: string, turnId: string | null) =>
      Effect.gen(function* () {
        if (input.replaceProgress === undefined) return;
        polls += 1;
        if (polls % 3 === 0) dots = nextWorkingDotCount(dots);
        const progress = teamsVisibleText({
          preface: input.preface ?? null,
          body,
          inProgress: true,
          dotCount: dots,
          toolCallCount: countTurnToolCalls(
            snapshot.thread.activities,
            turnId,
            snapshot.thread.messages,
          ),
          wakeNote: activeTurnWakeNote({
            latestTurnId: turnId,
            messages: snapshot.thread.messages,
            activities: snapshot.thread.activities,
          }),
        });
        if (progress === lastProgress) return;
        const updated = yield* edit(progress).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            Effect.logWarning("Teams progress update failed", {
              threadId: input.t3ThreadId,
              error: String(error),
            }).pipe(Effect.as(false)),
          ),
        );
        if (updated) lastProgress = progress;
      });
    if (input.messageId !== undefined && targetRun !== undefined) {
      const result = teamsRunDelivery(snapshot.thread, input.messageId);
      if (result.kind === "pending") {
        const commentary = finalAnswerText({
          ...snapshot.thread,
          session: null,
          latestTurn: {
            turnId: TurnId.make(targetRun.id),
            state: "running",
            requestedAt: snapshot.thread.updatedAt,
            startedAt: null,
            completedAt: snapshot.thread.updatedAt,
            assistantMessageId: null,
          },
          messages: snapshot.thread.messages.filter((message) => message.turnId === targetRun.id),
        });
        yield* showProgress(commentary, targetRun.id);
        continue;
      }
      // Allow one projection poll for the terminal assistant message to arrive.
      if (result.answer.length === 0 && ++emptyCompletedPolls < 2) continue;
      yield* publishFinal(
        teamsVisibleText({
          preface: input.preface ?? null,
          body:
            result.answer ||
            "T3 completed this run without an answer. Open the linked thread for details.",
          inProgress: false,
        }),
      );
      return;
    }
    const answer = finalAnswerText(snapshot.thread);
    const latestTurnId = snapshot.thread.latestTurn?.turnId ?? null;
    const answerIsNew =
      answer.length > 0 && !(answer === input.baseline && latestTurnId === input.baselineTurnId);
    if (!teamsTurnSettled(snapshot.thread)) {
      yield* showProgress(answerIsNew ? answer : "", latestTurnId);
      continue;
    }
    if (!answerIsNew) {
      if (
        snapshot.thread.latestTurn != null &&
        latestTurnId !== input.baselineTurnId &&
        answer.length === 0
      ) {
        yield* publishFinal(
          teamsVisibleText({
            preface: input.preface ?? null,
            body: "T3 finished without a reply.",
            inProgress: false,
          }),
        );
        return;
      }
      continue;
    }
    yield* publishFinal(
      teamsVisibleText({
        preface: input.preface ?? null,
        body: answer,
        inProgress: false,
      }),
    );
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
  const identityMap = yield* IdentityMapStore;
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

  app.on("message", async ({ activity, api, send, reply }) => {
    await run(
      Effect.gen(function* () {
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
        const preface = [
          turn.isNew
            ? `Started T3 for **${projectShortName}**.`
            : "Continued the linked T3 thread.",
          webLink === null ? null : `[Open in T3 Code](${webLink})`,
        ]
          .filter((line): line is string => line !== null)
          .join("\n");
        const ack = teamsVisibleText({ preface, body: "", inProgress: true });
        const sent = yield* Effect.promise(() => reply(ack));
        const progressId = sent.id;
        const conversationId = activity.conversation.id;
        const progressUpdate =
          progressId.length === 0
            ? {}
            : {
                replaceProgress: (text: string) =>
                  api.conversations.updateActivity(conversationId, progressId, {
                    type: "message" as const,
                    text,
                  }),
              };
        yield* Effect.forkDetach(
          waitForFinalAnswer({
            t3ThreadId: turn.threadId,
            messageId: turn.messageId,
            baseline,
            baselineTurnId,
            preface,
            send: (text) => send(text),
            ...progressUpdate,
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
