import {
  CommandId,
  MessageId,
  type OrchestrationThread,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  discoverGitHubTargetTurnId,
  githubFinalAnswerWithStats,
  resolveGitHubBridgeTurnOutcome,
} from "../github/GitHubPrBridge.ts";
import {
  ThreadWorkItemStore,
  type WorkItemLookupResult,
} from "../workItems/ThreadWorkItemStore.ts";
import { JiraAppClient } from "./JiraAppClient.ts";
import { JiraAppConfig, isJiraProjectAllowed } from "./JiraAppConfig.ts";
import { JiraDeliveryStore, type StoredJiraDelivery } from "./JiraDeliveryStore.ts";
import { resolveThreadIdForJiraIssue } from "./JiraThreadLookup.ts";
import { buildJiraTurnPrompt, type JiraIssueInvocation } from "./JiraWebhookPayload.ts";

const NOT_LINKED_RESPONSE = "not yet linked.";
const AMBIGUOUS_RESPONSE =
  "Multiple T3 threads are linked to this Jira issue, so the bot could not pick which one to use.";
const BUSY_RESPONSE =
  "This T3 thread is already working. Try again after the current turn finishes.";
const FAILED_RESPONSE =
  "T3 could not complete this request. Check the linked T3 thread for details.";
const EMPTY_PROMPT_RESPONSE =
  "Provide a prompt after the mention (for example: `@omegent investigate the packing failure`).";
const MAX_JIRA_COMMENT_LENGTH = 32_000;

export function formatJiraComment(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_JIRA_COMMENT_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_JIRA_COMMENT_LENGTH - 20)}\n\n…(truncated)`;
}

function isThreadBusy(thread: OrchestrationThread): boolean {
  const latest = thread.latestTurn;
  if (latest?.state === "running") return true;
  const session = thread.session;
  if (session === null) return false;
  return (
    session.activeTurnId !== null && (session.status === "running" || session.status === "starting")
  );
}

export class JiraIssueBridge extends Context.Service<
  JiraIssueBridge,
  {
    readonly handle: (input: {
      readonly deliveryId: string;
      readonly invocation: JiraIssueInvocation;
    }) => Effect.Effect<void>;
  }
>()("t3/jira/JiraIssueBridge") {}

const make = Effect.gen(function* () {
  const config = yield* JiraAppConfig;
  const deliveries = yield* JiraDeliveryStore;
  const workItems = yield* ThreadWorkItemStore;
  const jira = yield* JiraAppClient;
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;

  const postComment = (issueKey: string, body: string) =>
    jira.addIssueComment({ issueKey, body: formatJiraComment(body) });

  const updateDelivery = (delivery: StoredJiraDelivery, patch: Partial<StoredJiraDelivery>) =>
    Effect.gen(function* () {
      yield* deliveries.put({
        ...delivery,
        ...patch,
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      });
    });

  const finishDelivery = Effect.fn("JiraIssueBridge.finishDelivery")(function* (
    delivery: StoredJiraDelivery,
    body: string,
    status: "completed" | "rejected",
  ) {
    const posted = yield* postComment(delivery.issueKey, body);
    yield* deliveries.put({
      ...delivery,
      responseCommentId: posted?.id ?? delivery.responseCommentId,
      status,
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  /**
   * Resolve issue → thread from the server-native work-item store first.
   * Optionally import/promote from Discord links.json (migration fallback only).
   */
  const resolveLinkedThreadId = Effect.fn("JiraIssueBridge.resolveLinkedThreadId")(function* (
    issueKey: string,
  ): Effect.Effect<WorkItemLookupResult> {
    const primary = yield* workItems.resolveJiraIssue(issueKey);
    if (primary._tag !== "unlinked") return primary;

    const linksPath = config.enabled ? config.discordLinksPath : null;
    if (linksPath === null || linksPath.length === 0) {
      return { _tag: "unlinked" as const };
    }
    const raw = yield* fileSystem.readFileString(linksPath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) return { _tag: "unlinked" as const };

    // Promote all active Discord associations into the server store, then re-resolve.
    const imported = yield* workItems.importDiscordLinksJson(raw);
    if (imported.threadsTouched > 0) {
      yield* Effect.logInfo("Imported Discord work-item associations into server store", imported);
    }

    const afterImport = yield* workItems.resolveJiraIssue(issueKey);
    if (afterImport._tag !== "unlinked") return afterImport;

    // Last resort: pure Discord parse without promotion (e.g. decode shape mismatch on import).
    return resolveThreadIdForJiraIssue({ issueKey, linksJson: raw });
  });

  const bridgeTurn = Effect.fn("JiraIssueBridge.bridgeTurn")(function* (
    delivery: StoredJiraDelivery,
  ) {
    if (delivery.threadId === null) return;
    const startedAt = yield* Clock.currentTimeMillis;
    let tracked: StoredJiraDelivery = delivery;
    const timeoutMs = config.enabled ? config.turnTimeoutMs : 0;

    while ((yield* Clock.currentTimeMillis) - startedAt < timeoutMs) {
      const snapshot = yield* projection
        .getThreadDetailById(tracked.threadId as ThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(snapshot)) {
        yield* finishDelivery(tracked, FAILED_RESPONSE, "rejected");
        return;
      }
      const thread = snapshot.value;
      const resolveOptions = {
        userMessageId: tracked.userMessageId,
        previousTurnId: tracked.previousTurnId,
        knownTargetTurnId: tracked.targetTurnId,
      };
      const discoveredTurnId = discoverGitHubTargetTurnId(thread, resolveOptions);
      if (discoveredTurnId !== null && discoveredTurnId !== tracked.targetTurnId) {
        tracked = {
          ...tracked,
          targetTurnId: discoveredTurnId as TurnId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* deliveries.put(tracked);
      }

      const outcome = resolveGitHubBridgeTurnOutcome(thread, {
        ...resolveOptions,
        knownTargetTurnId: tracked.targetTurnId,
      });
      if (outcome._tag === "terminal") {
        const body =
          outcome.status === "completed"
            ? outcome.body ||
              githubFinalAnswerWithStats(thread, outcome.targetTurnId) ||
              FAILED_RESPONSE
            : outcome.body || FAILED_RESPONSE;
        yield* finishDelivery(tracked, body, outcome.status);
        return;
      }

      yield* Effect.sleep("1 second");
    }

    yield* finishDelivery(
      tracked,
      "T3 is still working. Open the linked T3 thread to continue monitoring this turn.",
      "completed",
    );
  });

  const handleUnsafe = Effect.fn("JiraIssueBridge.handleUnsafe")(function* (input: {
    readonly deliveryId: string;
    readonly invocation: JiraIssueInvocation;
  }) {
    if (!config.enabled) return;

    const now = DateTime.formatIso(yield* DateTime.now);
    const initial: StoredJiraDelivery = {
      deliveryId: input.deliveryId,
      issueKey: input.invocation.issueKey,
      projectKey: input.invocation.projectKey,
      sourceCommentId: input.invocation.commentId,
      replyToCommentId: input.invocation.replyToCommentId,
      commentSurface: input.invocation.commentSurface,
      responseCommentId: null,
      threadId: null,
      previousTurnId: null,
      userMessageId: null,
      targetTurnId: null,
      status: "received",
      createdAt: now,
      updatedAt: now,
    };
    if (!(yield* deliveries.claim(initial))) return;

    yield* Effect.logInfo("Accepted Jira issue invocation", {
      deliveryId: input.deliveryId,
      issueKey: input.invocation.issueKey,
      projectKey: input.invocation.projectKey,
      webhookEvent: input.invocation.webhookEvent,
      commentSurface: input.invocation.commentSurface,
      commentId: input.invocation.commentId,
      replyToCommentId: input.invocation.replyToCommentId,
      commentUpdatedAt: input.invocation.commentUpdatedAt,
      actorAccountId: input.invocation.actorAccountId,
      actorDisplayName: input.invocation.actorDisplayName,
    });

    if (!isJiraProjectAllowed(config.allowedProjects, input.invocation.projectKey)) {
      yield* Effect.logWarning("Ignoring Jira webhook from unauthorized project", {
        deliveryId: input.deliveryId,
        projectKey: input.invocation.projectKey,
        issueKey: input.invocation.issueKey,
      });
      yield* updateDelivery(initial, { status: "rejected" });
      return;
    }

    if (input.invocation.prompt.trim().length === 0) {
      yield* finishDelivery(initial, EMPTY_PROMPT_RESPONSE, "rejected");
      return;
    }

    const link = yield* resolveLinkedThreadId(input.invocation.issueKey);
    if (link._tag === "unlinked") {
      yield* finishDelivery(initial, NOT_LINKED_RESPONSE, "rejected");
      return;
    }
    if (link._tag === "ambiguous") {
      yield* finishDelivery(initial, AMBIGUOUS_RESPONSE, "rejected");
      return;
    }

    const snapshot = yield* projection
      .getThreadDetailById(link.threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(snapshot)) {
      yield* finishDelivery(initial, NOT_LINKED_RESPONSE, "rejected");
      return;
    }
    const thread = snapshot.value;

    // Keep the server-native association durable once a turn is accepted.
    yield* workItems
      .appendForThread({
        threadId: thread.id,
        jiraIssueKeys: [input.invocation.issueKey],
        source: "jira-webhook",
      })
      .pipe(Effect.ignore);

    if (isThreadBusy(thread)) {
      yield* finishDelivery({ ...initial, threadId: thread.id }, BUSY_RESPONSE, "completed");
      return;
    }

    const commandId = CommandId.make(yield* crypto.randomUUIDv4);
    const messageId = MessageId.make(yield* crypto.randomUUIDv4);
    const processing: StoredJiraDelivery = {
      ...initial,
      threadId: thread.id,
      previousTurnId: thread.latestTurn?.turnId ?? null,
      userMessageId: messageId,
      targetTurnId: null,
      status: "processing",
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* deliveries.put(processing);

    yield* Effect.logInfo("Dispatching Jira issue invocation to T3 thread", {
      deliveryId: input.deliveryId,
      threadId: thread.id,
      issueKey: input.invocation.issueKey,
      userMessageId: messageId,
    });

    const dispatched = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId,
        threadId: thread.id,
        message: {
          messageId,
          role: "user",
          text: buildJiraTurnPrompt(input.invocation),
          attachments: [],
        },
        modelSelection: thread.modelSelection,
        titleSeed: input.invocation.prompt.slice(0, 80) || "Jira comment",
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          finishDelivery(processing, FAILED_RESPONSE, "rejected").pipe(
            Effect.andThen(Effect.logError("Failed to dispatch Jira turn", { cause })),
            Effect.as(false),
          ),
        ),
      );
    if (!dispatched) return;

    yield* Effect.forkDetach(
      bridgeTurn(processing).pipe(
        Effect.catchCause((cause) =>
          finishDelivery(processing, FAILED_RESPONSE, "rejected").pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.logError("Jira response bridge stopped", {
                deliveryId: processing.deliveryId,
                threadId: processing.threadId,
                cause,
              }),
            ),
          ),
        ),
      ),
    );
  });

  const handle = (input: {
    readonly deliveryId: string;
    readonly invocation: JiraIssueInvocation;
  }) =>
    handleUnsafe(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Jira issue invocation failed", {
          deliveryId: input.deliveryId,
          issueKey: input.invocation.issueKey,
          cause,
        }),
      ),
    );

  const restore = deliveries.listProcessing().pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(pending, (delivery) => Effect.forkDetach(bridgeTurn(delivery)), {
        concurrency: 4,
        discard: true,
      }),
    ),
  );
  if (config.enabled) yield* restore;

  return JiraIssueBridge.of({ handle });
});

export const layer = Layer.effect(JiraIssueBridge, make);
