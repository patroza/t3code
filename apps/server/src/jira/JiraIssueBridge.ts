import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
  type OrchestrationThread,
  type SourceRef,
  type TurnId,
} from "@t3tools/contracts";
import { buildAgentAwarenessDeepLink } from "@t3tools/shared/agentAwareness";
import type { IdentityMapPerson } from "@t3tools/shared/identityMap";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

import { hostedAppUrlConfig } from "../cloud/publicConfig.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import {
  discoverGitHubTargetTurnId,
  githubFinalAnswerWithStats,
  resolveGitHubBridgeTurnOutcome,
} from "../github/GitHubPrBridge.ts";
import * as IdentityService from "../identity/IdentityService.ts";
import { buildIntegrationSourceRef } from "../identity/stampSource.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { getAutoBootstrapDefaultModelSelection } from "../serverRuntimeStartup.ts";
import {
  ThreadWorkItemStore,
  type WorkItemLookupResult,
} from "../workItems/ThreadWorkItemStore.ts";
import { JiraAppClient } from "./JiraAppClient.ts";
import {
  JiraAppConfig,
  isJiraProjectAllowed,
  resolveMappedT3ProjectId,
  resolveT3ProjectIdForJiraKey,
} from "./JiraAppConfig.ts";
import { JiraDeliveryStore, type StoredJiraDelivery } from "./JiraDeliveryStore.ts";
import { resolveDiscordLinkForJiraIssue, resolveThreadIdForJiraIssue } from "./JiraThreadLookup.ts";
import { classifyJiraActorTrust, type JiraActorTrustDecision } from "./jiraActorTrust.ts";
import {
  formatDiscordJiraContextNote,
  postDiscordChannelMessage,
  resolveDiscordBotToken,
} from "./jiraDiscordContext.ts";
import { buildJiraTurnPrompt, type JiraIssueInvocation } from "./JiraWebhookPayload.ts";

const NOT_LINKED_RESPONSE =
  "not yet linked. No T3 thread lists this issue, and auto-create could not pick a project (set T3CODE_JIRA_PROJECT_MAP for this Jira key, T3CODE_JIRA_DEFAULT_PROJECT_ID, or ensure exactly one T3 project exists).";
const CREATE_DISABLED_RESPONSE =
  "not yet linked. Auto-create is disabled; link this issue from Chat or enable auto-create.";
const AMBIGUOUS_RESPONSE =
  "Multiple chat threads are linked to this Jira issue, so the bot could not pick which one to use.";
const FAILED_RESPONSE =
  "Could not complete this request. Check the linked chat thread for details.";
const EMPTY_PROMPT_RESPONSE =
  "Provide a prompt after the mention (for example: `@omegent investigate the packing failure`).";
const CREATE_FAILED_RESPONSE =
  "Could not create a chat thread for this Jira issue. Check server logs or link an existing thread.";
/** Untrusted-actor replies: short, no product jargon; @-mention is applied separately in ADF. */
const CONTEXT_UNAUTHORIZED_RESPONSE =
  "You're not currently authorized to run agent work from Jira. Please ask a team member who is authorized to take this forward.";
const CONTEXT_NOTED_RESPONSE =
  "Thanks — noted for the team. You're not currently authorized to run agent work from Jira, so this was filed as context only. An authorized teammate can pick it up.";
const CONTEXT_FAILED_RESPONSE =
  "You're not currently authorized to run agent work from Jira, and I couldn't file this as context either. Please ping an authorized teammate.";
const MAX_JIRA_COMMENT_LENGTH = 32_000;

function jiraSourceRef(
  invocation: JiraIssueInvocation,
  people: ReadonlyArray<IdentityMapPerson>,
): SourceRef {
  return buildIntegrationSourceRef({
    people,
    channel: "jira",
    platformId: invocation.actorAccountId,
    displayName: invocation.actorDisplayName,
    location: {
      ...(invocation.projectKey ? { projectKey: invocation.projectKey } : {}),
      issueKey: invocation.issueKey,
    },
  });
}

export function formatJiraComment(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= MAX_JIRA_COMMENT_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_JIRA_COMMENT_LENGTH - 20)}\n\n…(truncated)`;
}

export function buildJiraT3ThreadUrl(input: {
  readonly hostedAppUrl: string;
  readonly environmentId: string;
  readonly threadId: string;
}): string {
  return new URL(
    buildAgentAwarenessDeepLink({
      environmentId: input.environmentId as EnvironmentId,
      threadId: input.threadId as ThreadId,
    }),
    input.hostedAppUrl,
  ).toString();
}

export function appendJiraT3ThreadLink(
  body: string,
  input:
    | {
        readonly hostedAppUrl: string;
        readonly environmentId: string;
        readonly threadId: string;
      }
    | null
    | undefined,
): string {
  const base = body.trimEnd();
  if (input === null || input === undefined) return base;
  const url = buildJiraT3ThreadUrl(input);
  if (base.includes(url)) return base;
  const footer = `T3 thread: ${url}`;
  if (base === "") return footer;
  return `${base}\n\n${footer}`;
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
  const serverEnvironment = yield* ServerEnvironment;
  const identity = yield* IdentityService.IdentityService;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const createLock = yield* Semaphore.make(1);
  const hostedAppUrl = yield* hostedAppUrlConfig;
  const environmentId = yield* serverEnvironment.getEnvironmentId;

  const resolveActorTrust = (invocation: JiraIssueInvocation) =>
    Effect.gen(function* () {
      const people = yield* identity.listMapPeople();
      const mapEnabled = yield* identity.isMapEnabled();
      return classifyJiraActorTrust({
        identityMapEnabled: mapEnabled,
        actorAccountId: invocation.actorAccountId,
        people,
      }) satisfies JiraActorTrustDecision;
    });

  /**
   * Post a bridge response as an **inline threaded reply** under the user's mention.
   *
   * Parent candidates (JiraAppClient resolves each to the **thread root** via GET —
   * Jira rejects nesting under a child comment with 400):
   * 1. `sourceCommentId` — the triggering mention (reply next to the user)
   * 2. `replyToCommentId` — webhook parent / root when present and different
   *
   * Never intentionally posts a bare top-level comment first; flat fallback is only
   * if every resolved parentId is rejected (see JiraAppClient).
   */
  const postComment = (delivery: StoredJiraDelivery, body: string) => {
    const mentionParent = delivery.sourceCommentId.trim();
    const replyParent = delivery.replyToCommentId.trim();
    // Prefer the mention itself so we always answer that comment's thread; client
    // walks parentId up to the root when the mention is already a nested reply.
    const parentCommentId = mentionParent.length > 0 ? mentionParent : null;
    return jira.addIssueComment({
      issueKey: delivery.issueKey,
      body: formatJiraComment(
        appendJiraT3ThreadLink(
          body,
          delivery.threadId === null
            ? null
            : {
                hostedAppUrl,
                environmentId,
                threadId: delivery.threadId,
              },
        ),
      ),
      parentCommentId,
      fallbackParentCommentId:
        replyParent.length > 0 && replyParent !== mentionParent ? replyParent : null,
      // Normal Jira reply style: @ the human who triggered the bot.
      mentionAccountId: delivery.actorAccountId,
      mentionDisplayName: delivery.actorDisplayName,
    });
  };

  const updateDelivery = (delivery: StoredJiraDelivery, patch: Partial<StoredJiraDelivery>) =>
    DateTime.now.pipe(
      Effect.flatMap((now) =>
        deliveries.put({ ...delivery, ...patch, updatedAt: DateTime.formatIso(now) }),
      ),
    );

  const removeAcknowledgment = (delivery: StoredJiraDelivery) => {
    const emojiId = delivery.acknowledgmentEmojiId;
    if (emojiId === null || emojiId.length === 0 || delivery.sourceCommentId.length === 0) {
      return Effect.void;
    }
    return jira
      .removeCommentReaction({
        issueKey: delivery.issueKey,
        commentId: delivery.sourceCommentId,
        emojiId,
      })
      .pipe(
        Effect.tapError((cause) =>
          Effect.logWarning("Failed to remove Jira acknowledgment reaction", {
            issueKey: delivery.issueKey,
            commentId: delivery.sourceCommentId,
            emojiId,
            cause,
          }),
        ),
        Effect.ignore,
      );
  };

  const finishDelivery = Effect.fn("JiraIssueBridge.finishDelivery")(function* (
    delivery: StoredJiraDelivery,
    body: string,
    status: "completed" | "rejected",
  ) {
    const posted = yield* postComment(delivery, body);
    yield* removeAcknowledgment(delivery);
    yield* deliveries.put({
      ...delivery,
      responseCommentId: posted?.id ?? delivery.responseCommentId,
      acknowledgmentEmojiId: null,
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
  ) {
    const primary = yield* workItems.resolveJiraIssue(issueKey);
    if (primary._tag !== "unlinked") return primary;

    const linksPath = config.enabled ? config.discordLinksPath : null;
    if (linksPath === null || linksPath.length === 0) {
      return { _tag: "unlinked" } satisfies WorkItemLookupResult;
    }
    const raw = yield* fileSystem.readFileString(linksPath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) {
      return { _tag: "unlinked" } satisfies WorkItemLookupResult;
    }

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

  /**
   * Pick a T3 project for auto-created Jira threads (join-or-create).
   * Order: projectMap[jiraKey] → defaultProjectId → sole shell project.
   */
  const resolveCreateProjectId = Effect.fn("JiraIssueBridge.resolveCreateProjectId")(function* (
    invocation: JiraIssueInvocation,
  ) {
    if (!config.enabled) return null as string | null;
    const shell = yield* projection.getShellSnapshot().pipe(Effect.orElseSucceed(() => null));
    const projects = (shell?.projects ?? []).map((project) => ({
      id: project.id,
      title: project.title,
      workspaceRoot: project.workspaceRoot,
    }));

    const fromMap = resolveT3ProjectIdForJiraKey(
      config.projectMap,
      invocation.projectKey,
      projects,
    );
    if (fromMap !== null) {
      yield* Effect.logInfo("Resolved Jira auto-create project from project map", {
        jiraProjectKey: invocation.projectKey,
        t3ProjectId: fromMap,
        issueKey: invocation.issueKey,
      });
      return fromMap;
    }

    if (config.defaultProjectId !== null && config.defaultProjectId.length > 0) {
      const fromDefault = resolveMappedT3ProjectId(config.defaultProjectId, projects);
      if (fromDefault !== null) return fromDefault;
      // Allow raw id even if shell snapshot is briefly empty (create path re-checks).
      if (projects.length === 0) return config.defaultProjectId;
      yield* Effect.logWarning("T3CODE_JIRA_DEFAULT_PROJECT_ID did not match any shell project", {
        defaultProjectId: config.defaultProjectId,
        issueKey: invocation.issueKey,
      });
    }

    if (projects.length === 1) return projects[0]!.id;
    return null;
  });

  /**
   * First surface for this issue: create a thread, attach the Jira key, return live detail.
   * Worktree is null (chat/session first); later PR/Discord surfaces can join via the store.
   */
  const createThreadForIssue = Effect.fn("JiraIssueBridge.createThreadForIssue")(function* (
    invocation: JiraIssueInvocation,
  ) {
    return yield* createLock.withPermit(
      Effect.gen(function* () {
        // Another delivery may have created while we waited.
        const again = yield* resolveLinkedThreadId(invocation.issueKey);
        if (again._tag === "linked") {
          const existing = yield* projection
            .getThreadDetailById(again.threadId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(existing)) return existing.value;
        }
        if (again._tag === "ambiguous") return null;

        const projectIdRaw = yield* resolveCreateProjectId(invocation);
        if (projectIdRaw === null) return null;

        const shell = yield* projection.getShellSnapshot().pipe(Effect.orElseSucceed(() => null));
        const project = shell?.projects.find((candidate) => candidate.id === projectIdRaw);
        if (project === undefined) {
          yield* Effect.logWarning("Jira auto-create project not found in shell", {
            projectId: projectIdRaw,
            issueKey: invocation.issueKey,
          });
          return null;
        }

        const threadId = ThreadId.make(yield* crypto.randomUUIDv4);
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const title =
          invocation.issueSummary?.trim() || `${invocation.issueKey} · Jira` || invocation.issueKey;
        const modelSelection =
          project.defaultModelSelection ?? getAutoBootstrapDefaultModelSelection();

        yield* Effect.logInfo("Creating T3 thread for unlinked Jira issue", {
          issueKey: invocation.issueKey,
          projectId: project.id,
          threadId,
        });

        yield* engine.dispatch({
          type: "thread.create",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          threadId,
          projectId: ProjectId.make(project.id),
          title: title.slice(0, 120),
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        });

        yield* workItems.appendForThread({
          threadId,
          jiraIssueKeys: [invocation.issueKey],
          source: "jira-webhook",
        });

        const created = yield* projection
          .getThreadDetailById(threadId)
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(created)) {
          yield* Effect.logError("Jira auto-create succeeded but thread detail missing", {
            threadId,
            issueKey: invocation.issueKey,
          });
          return null;
        }
        return created.value;
      }),
    );
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
      acknowledgmentEmojiId: null,
      actorAccountId: input.invocation.actorAccountId,
      actorDisplayName: input.invocation.actorDisplayName,
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

    // Best-effort 👀 on the triggering comment (like Discord/GitHub eyes). Cleared in finishDelivery.
    const ackEmojiConfigured = config.ackEmojiId;
    let acknowledged: StoredJiraDelivery = initial;
    if (ackEmojiConfigured !== null && ackEmojiConfigured.length > 0) {
      const appliedEmojiId = yield* jira
        .addCommentReaction({
          issueKey: input.invocation.issueKey,
          commentId: input.invocation.commentId,
          emojiId: ackEmojiConfigured,
        })
        .pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("Failed to add Jira acknowledgment reaction", {
              deliveryId: input.deliveryId,
              issueKey: input.invocation.issueKey,
              commentId: input.invocation.commentId,
              cause,
            }),
          ),
          Effect.orElseSucceed(() => null),
        );
      if (appliedEmojiId !== null) {
        acknowledged = {
          ...initial,
          acknowledgmentEmojiId: appliedEmojiId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        };
        yield* deliveries.put(acknowledged);
      }
    }

    if (input.invocation.prompt.trim().length === 0) {
      yield* finishDelivery(acknowledged, EMPTY_PROMPT_RESPONSE, "rejected");
      return;
    }

    const trust = yield* resolveActorTrust(input.invocation);
    yield* Effect.logInfo("Classified Jira actor trust", {
      deliveryId: input.deliveryId,
      issueKey: input.invocation.issueKey,
      actorAccountId: input.invocation.actorAccountId,
      mode: trust.mode,
      reason: trust.reason,
      personId: trust.person?.personId ?? null,
    });

    const link = yield* resolveLinkedThreadId(input.invocation.issueKey);
    if (link._tag === "ambiguous") {
      yield* finishDelivery(acknowledged, AMBIGUOUS_RESPONSE, "rejected");
      return;
    }

    // Untrusted actors: optional chat context note only (no agent). Never auto-creates.
    // Requires a unique chat-linked issue in links.json when filing context.
    if (trust.mode === "context-only") {
      const linksPath = config.discordLinksPath;
      if (linksPath === null || linksPath.length === 0) {
        yield* finishDelivery(acknowledged, CONTEXT_UNAUTHORIZED_RESPONSE, "rejected");
        return;
      }
      const linksRaw = yield* fileSystem
        .readFileString(linksPath)
        .pipe(Effect.orElseSucceed(() => ""));
      const discordLink = resolveDiscordLinkForJiraIssue({
        issueKey: input.invocation.issueKey,
        linksJson: linksRaw,
      });
      if (discordLink._tag === "unlinked" || discordLink._tag === "ambiguous") {
        yield* finishDelivery(acknowledged, CONTEXT_UNAUTHORIZED_RESPONSE, "rejected");
        return;
      }

      const token = yield* Effect.promise(() => resolveDiscordBotToken());
      if (token === null) {
        yield* finishDelivery(acknowledged, CONTEXT_FAILED_RESPONSE, "rejected");
        return;
      }

      const requester =
        input.invocation.actorDisplayName ?? input.invocation.actorAccountId ?? "unknown";
      const content = formatDiscordJiraContextNote({
        issueKey: input.invocation.issueKey,
        requester,
        prompt: input.invocation.prompt,
        commentUrl: input.invocation.commentUrl,
      });
      const posted = yield* Effect.promise(() =>
        postDiscordChannelMessage({
          token,
          channelId: discordLink.discordThreadId,
          content,
        })
          .then((message) => ({ _tag: "ok" as const, message }))
          .catch((cause) => ({ _tag: "err" as const, cause })),
      );
      if (posted._tag === "err") {
        yield* Effect.logError("Failed to post Jira context-only note to Discord", {
          deliveryId: input.deliveryId,
          issueKey: input.invocation.issueKey,
          discordThreadId: discordLink.discordThreadId,
          cause: posted.cause,
        });
        yield* finishDelivery(acknowledged, CONTEXT_FAILED_RESPONSE, "rejected");
        return;
      }

      yield* Effect.logInfo("Posted Jira context-only note to Discord (no agent run)", {
        deliveryId: input.deliveryId,
        issueKey: input.invocation.issueKey,
        discordThreadId: discordLink.discordThreadId,
        t3ThreadId: discordLink.t3ThreadId,
        discordMessageId: posted.message.id,
      });
      const notedDelivery: StoredJiraDelivery = {
        ...acknowledged,
        threadId:
          discordLink.t3ThreadId !== null
            ? (discordLink.t3ThreadId as ThreadId)
            : acknowledged.threadId,
      };
      yield* finishDelivery(notedDelivery, CONTEXT_NOTED_RESPONSE, "completed");
      return;
    }

    let thread: OrchestrationThread;
    if (link._tag === "linked") {
      const snapshot = yield* projection
        .getThreadDetailById(link.threadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(snapshot)) {
        // Stale store entry — try create if enabled.
        if (!config.enabled || !config.autoCreateThread) {
          yield* finishDelivery(acknowledged, NOT_LINKED_RESPONSE, "rejected");
          return;
        }
        const created = yield* createThreadForIssue(input.invocation);
        if (created === null) {
          yield* finishDelivery(acknowledged, CREATE_FAILED_RESPONSE, "rejected");
          return;
        }
        thread = created;
      } else {
        thread = snapshot.value;
      }
    } else {
      // unlinked — join-or-create (trusted actors only)
      if (!config.enabled || !config.autoCreateThread) {
        yield* finishDelivery(acknowledged, CREATE_DISABLED_RESPONSE, "rejected");
        return;
      }
      const created = yield* createThreadForIssue(input.invocation);
      if (created === null) {
        yield* finishDelivery(acknowledged, NOT_LINKED_RESPONSE, "rejected");
        return;
      }
      thread = created;
    }

    // Keep the server-native association durable once a turn is accepted.
    yield* workItems
      .appendForThread({
        threadId: thread.id,
        jiraIssueKeys: [input.invocation.issueKey],
        source: "jira-webhook",
      })
      .pipe(Effect.ignore);

    // Always dispatch. When the thread is mid-turn, orchestration queues the
    // message (thread.message-queued) — do not short-circuit with a busy reply.
    // Response posting stays async via forkDetach(bridgeTurn) below.
    const commandId = CommandId.make(yield* crypto.randomUUIDv4);
    const messageId = MessageId.make(yield* crypto.randomUUIDv4);
    const processing: StoredJiraDelivery = {
      ...acknowledged,
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
      trustMode: trust.mode,
      personId: trust.person?.personId ?? null,
    });

    const mapPeople = yield* identity.listMapPeople();
    const source = jiraSourceRef(input.invocation, mapPeople);
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
        source,
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
