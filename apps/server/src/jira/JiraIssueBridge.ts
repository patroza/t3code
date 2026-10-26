import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type EnvironmentId,
  MessageId,
  ProjectId,
  ThreadId,
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
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import {
  discoverGitHubTargetTurnId,
  githubFinalAnswerWithStats,
  resolveGitHubBridgeTurnOutcome,
} from "../github/GitHubPrBridge.ts";
import * as IdentityService from "../identity/IdentityService.ts";
import { buildIntegrationSourceRef } from "../identity/stampSource.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import {
  integrationThreadView,
  integrationThreadShellView,
  type IntegrationThreadView as OrchestrationThread,
} from "@t3tools/shared/integrationThreadView";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { getAutoBootstrapThreadModelSelection } from "../serverRuntimeStartup.ts";
import {
  ThreadWorkItemStore,
  type WorkItemLookupResult,
} from "../workItems/ThreadWorkItemStore.ts";
import { JiraAppClient } from "./JiraAppClient.ts";
import {
  buildJiraBugReportPrompt,
  collectBugMilestones,
  fallbackBugMilestones,
  teamJiraMentions,
  type BugMilestones,
  type JiraBugReport,
} from "./JiraBugReport.ts";
import {
  JiraAppConfig,
  isJiraProjectAllowed,
  resolveMappedT3ProjectId,
  resolveT3ProjectIdForJiraKey,
} from "./JiraAppConfig.ts";
import {
  confluencePageForProject,
  jiraAttachmentFilename,
  jiraResponseStamp,
} from "./JiraCommentPublish.ts";
import { jiraOverflowNotice, partitionJiraComment } from "./JiraMarkdown.ts";
import { JiraDeliveryStore, type StoredJiraDelivery } from "./JiraDeliveryStore.ts";
import { resolveDiscordLinkForJiraIssue } from "./JiraThreadLookup.ts";
import { classifyJiraActorTrust, type JiraActorTrustDecision } from "./jiraActorTrust.ts";
import {
  formatDiscordJiraContextNote,
  postDiscordChannelMessage,
  resolveDiscordBotToken,
} from "./jiraDiscordContext.ts";
import {
  buildJiraTurnPrompt,
  type JiraAdfMention,
  type JiraIssueInvocation,
} from "./JiraWebhookPayload.ts";

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
  "T3 could not create a worktree thread for this Jira issue. Check server logs or link an existing thread.";
/** Untrusted-actor replies: short, no product jargon; @-mention is applied separately in ADF. */
const CONTEXT_UNAUTHORIZED_RESPONSE =
  "You're not currently authorized to run agent work from Jira. Please ask a team member who is authorized to take this forward.";
const CONTEXT_NOTED_RESPONSE =
  "Thanks, noted for the team. You're not currently authorized to run agent work from Jira, so this was filed as context only. An authorized teammate can pick it up.";
const CONTEXT_FAILED_RESPONSE =
  "You're not currently authorized to run agent work from Jira, and I couldn't file this as context either. Please ping an authorized teammate.";

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

const JIRA_READ_RECEIPT_BY_ID: Readonly<Record<string, string>> = {
  "1f44d": "👍",
  "1f440": "👀",
  thumbsup: "👍",
  "+1": "👍",
  eyes: "👀",
};

/**
 * Glyph replied on the triggering comment as soon as a mention is accepted.
 * Null skips the receipt (`T3CODE_JIRA_ACK_EMOJI_ID` empty).
 */
export function jiraReadReceiptText(ackEmojiId: string | null): string | null {
  if (ackEmojiId === null) return null;
  const trimmed = ackEmojiId.trim();
  if (trimmed.length === 0) return null;
  const mapped = JIRA_READ_RECEIPT_BY_ID[trimmed.toLowerCase()] ?? JIRA_READ_RECEIPT_BY_ID[trimmed];
  if (mapped !== undefined) return mapped;
  if (/[^\da-f]/iu.test(trimmed)) return trimmed;
  return "👀";
}

export function formatJiraComment(body: string): string {
  return body.trim();
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

/**
 * Key-first branch for Jira auto-create worktrees so GitHub-for-Jira can link
 * Development panel entries (e.g. SA-402-t3-a1b2c3d4).
 */
export function buildJiraAutoCreateBranchName(issueKey: string, shortId: string): string {
  const key = issueKey.trim().toUpperCase();
  const suffix = shortId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "")
    .slice(0, 8);
  return suffix.length > 0 ? `${key}-t3-${suffix}` : `${key}-t3`;
}

export class JiraIssueBridge extends Context.Service<
  JiraIssueBridge,
  {
    readonly handle: (input: {
      readonly deliveryId: string;
      readonly invocation: JiraIssueInvocation;
    }) => Effect.Effect<void>;
    readonly handleBug: (input: {
      readonly deliveryId: string;
      readonly report: JiraBugReport;
    }) => Effect.Effect<void>;
  }
>()("t3/jira/JiraIssueBridge") {}

type JiraWorkTarget = {
  readonly issueKey: string;
  readonly issueSummary: string | null;
  readonly projectKey: string;
};

const make = Effect.gen(function* () {
  const config = yield* JiraAppConfig;
  const deliveries = yield* JiraDeliveryStore;
  const workItems = yield* ThreadWorkItemStore;
  const jira = yield* JiraAppClient;
  const engine = yield* OrchestratorV2;
  const engineProjection = yield* OrchestratorV2;
  const projectStore = yield* ProjectStoreV2;
  const projection = {
    getShellSnapshot: () =>
      Effect.all([engineProjection.getShellSnapshot(), projectStore.listShells()], {
        concurrency: "unbounded",
      }).pipe(
        Effect.map(([shell, projects]) => ({
          ...shell,
          projects,
          threads: shell.threads.map(integrationThreadShellView),
        })),
      ),
    getThreadShellById: (id: ThreadId) =>
      engineProjection
        .getThreadShell(id)
        .pipe(
          Effect.map((shell) =>
            shell === null ? Option.none() : Option.some(integrationThreadShellView(shell)),
          ),
        ),
    getThreadDetailById: (id: ThreadId) =>
      engineProjection
        .getThreadProjection(id)
        .pipe(Effect.map((value) => Option.some(integrationThreadView(value)))),
  };
  const serverEnvironment = yield* ServerEnvironment;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectSetupScriptRunner = yield* ProjectSetupScriptRunner;
  const identity = yield* IdentityService.IdentityService;
  const fileSystem = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  const createLock = yield* Semaphore.make(1);
  const hostedAppUrl = yield* hostedAppUrlConfig;
  const environmentId = yield* serverEnvironment.getEnvironmentId;

  const resolveActorTrust = Effect.fn("JiraIssueBridge.resolveActorTrust")(function* (
    invocation: JiraIssueInvocation,
  ) {
    const people = yield* identity.listMapPeople();
    const mapEnabled = yield* identity.isMapEnabled();
    return classifyJiraActorTrust({
      identityMapEnabled: mapEnabled,
      actorAccountId: invocation.actorAccountId,
      people,
    }) satisfies JiraActorTrustDecision;
  });

  // Resolve the triggering comment, then webhook parent, to a thread root before replying.
  // Try flat fallback only after every resolved parent is rejected, never as the first attempt.
  const storeOverflow = Effect.fn("JiraIssueBridge.storeOverflow")(function* (
    delivery: StoredJiraDelivery,
    overflow: string,
  ) {
    const heading = jiraResponseStamp(DateTime.formatIso(yield* DateTime.now));
    const target = config.enabled
      ? confluencePageForProject(config.confluencePages, delivery.projectKey)
      : null;
    const published =
      target === null
        ? null
        : yield* jira.publishConfluenceSection({
            issueKey: delivery.issueKey,
            spaceKey: target.spaceKey,
            parentTitles: target.parentTitles,
            title: delivery.issueKey,
            heading,
            markdown: overflow,
          });
    const stored =
      published ??
      (yield* jira.addIssueAttachment({
        issueKey: delivery.issueKey,
        filename: jiraAttachmentFilename(delivery.issueKey, heading),
        markdown: overflow,
      }));
    return jiraOverflowNotice(stored);
  });

  const postComment = Effect.fn("JiraIssueBridge.postComment")(function* (
    delivery: StoredJiraDelivery,
    body: string,
  ) {
    const mentionParent = delivery.sourceCommentId.trim();
    const replyParent = delivery.replyToCommentId.trim();
    // Prefer the mention itself so we always answer that comment's thread; client
    // walks parentId up to the root when the mention is already a nested reply.
    const parentCommentId = mentionParent.length > 0 ? mentionParent : null;
    const prepared = partitionJiraComment(body);
    const notice =
      prepared.overflow === null ? null : yield* storeOverflow(delivery, prepared.overflow);
    const inline = [prepared.inline, notice]
      .filter((part): part is string => part !== null && part.trim().length > 0)
      .join("\n\n");
    return yield* jira.addIssueComment({
      issueKey: delivery.issueKey,
      body: formatJiraComment(
        appendJiraT3ThreadLink(
          inline,
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
  });

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
   * Resolve issue → thread from associations Jira or GitHub recorded.
   * A miss also drops Discord-only rows so an old pin import cannot keep matching.
   */
  const resolveLinkedThreadId = Effect.fn("JiraIssueBridge.resolveLinkedThreadId")(function* (
    issueKey: string,
  ) {
    const primary = yield* workItems.resolveJiraIssue(issueKey);
    if (primary._tag !== "unlinked") return primary;

    const linksPath = config.enabled ? config.discordLinksPath : null;
    const raw =
      linksPath === null || linksPath.length === 0
        ? ""
        : yield* fileSystem.readFileString(linksPath).pipe(Effect.orElseSucceed(() => ""));
    if (raw.trim().length === 0) {
      return { _tag: "unlinked" } satisfies WorkItemLookupResult;
    }

    const imported = yield* workItems.importDiscordLinksJson(raw);
    if (imported.threadsTouched > 0) {
      yield* Effect.logInfo("Dropped Discord-only work-item associations", imported);
    }
    return yield* workItems.resolveJiraIssue(issueKey);
  });

  /**
   * Pick a T3 project for auto-created Jira threads (join-or-create).
   * Order: projectMap[jiraKey] → defaultProjectId → sole shell project.
   */
  const resolveCreateProjectId = Effect.fn("JiraIssueBridge.resolveCreateProjectId")(function* (
    invocation: JiraWorkTarget,
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
   * First surface for this issue: create a dedicated worktree + thread, attach the Jira key.
   * Never opens on the project main checkout — same isolation as Discord/GitHub create paths.
   * Later surfaces join via ThreadWorkItemStore.
   */
  const createThreadForIssue = Effect.fn("JiraIssueBridge.createThreadForIssue")(function* (
    invocation: JiraWorkTarget,
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

        const threadId = ThreadId.make(yield* crypto.randomUUIDv4());
        const title =
          invocation.issueSummary?.trim() || `${invocation.issueKey} · Jira` || invocation.issueKey;
        const modelSelection =
          project.defaultModelSelection ?? getAutoBootstrapThreadModelSelection();
        const branchName = buildJiraAutoCreateBranchName(
          invocation.issueKey,
          (yield* crypto.randomUUIDv4()).slice(0, 8),
        );
        const baseBranch = config.enabled ? config.baseBranch : "main";

        yield* Effect.logInfo("Creating T3 worktree thread for unlinked Jira issue", {
          issueKey: invocation.issueKey,
          projectId: project.id,
          threadId,
          workspaceRoot: project.workspaceRoot,
          baseBranch,
          branch: branchName,
        });

        const prepared = yield* Effect.gen(function* () {
          yield* gitWorkflow.fetchRemote({
            cwd: project.workspaceRoot,
            remoteName: "origin",
          });
          const resolvedRemoteBase = yield* gitWorkflow.resolveRemoteTrackingCommit({
            cwd: project.workspaceRoot,
            refName: baseBranch,
            fallbackRemoteName: "origin",
          });
          const worktree = yield* gitWorkflow.createWorktree({
            cwd: project.workspaceRoot,
            refName: resolvedRemoteBase.commitSha,
            newRefName: branchName,
            baseRefName: baseBranch,
            path: null,
          });
          return {
            branch: worktree.worktree.refName,
            worktreePath: worktree.worktree.path,
          };
        }).pipe(
          Effect.catch((cause) =>
            Effect.logError("Jira auto-create worktree failed", {
              issueKey: invocation.issueKey,
              projectId: project.id,
              workspaceRoot: project.workspaceRoot,
              baseBranch,
              branch: branchName,
              cause,
            }).pipe(Effect.as(null)),
          ),
        );
        if (prepared === null) return null;

        yield* engine.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "server",
          commandId: CommandId.make(yield* crypto.randomUUIDv4()),
          threadId,
          projectId: ProjectId.make(project.id),
          title: title.slice(0, 120),
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: prepared.branch,
          worktreePath: prepared.worktreePath,
        });

        yield* projectSetupScriptRunner
          .runForThread({
            threadId,
            projectId: project.id,
            projectCwd: project.workspaceRoot,
            worktreePath: prepared.worktreePath,
          })
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Jira-provisioned T3 thread setup script failed", {
                issueKey: invocation.issueKey,
                projectId: project.id,
                threadId,
                worktreePath: prepared.worktreePath,
                cause,
              }),
            ),
          );

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
          ...delivery,
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

    // Reply on the triggering comment immediately so the author can see the mention
    // was read. Jira Cloud does not accept comment reactions for this API token.
    const acknowledged: StoredJiraDelivery = initial;
    const receiptText = jiraReadReceiptText(config.ackEmojiId);
    if (receiptText !== null && input.invocation.commentSurface !== "assignment") {
      const mentionParent = input.invocation.commentId.trim();
      const replyParent = input.invocation.replyToCommentId.trim();
      const posted = yield* jira.addIssueComment({
        issueKey: input.invocation.issueKey,
        body: receiptText,
        parentCommentId: mentionParent.length > 0 ? mentionParent : null,
        fallbackParentCommentId:
          replyParent.length > 0 && replyParent !== mentionParent ? replyParent : null,
        mentionAccountId: input.invocation.actorAccountId,
        mentionDisplayName: input.invocation.actorDisplayName,
      });
      if (posted !== null) {
        yield* Effect.logInfo("Posted Jira read receipt", {
          deliveryId: input.deliveryId,
          issueKey: input.invocation.issueKey,
          commentId: posted.id,
          parentId: posted.parentId,
        });
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
        yield* finishDelivery(acknowledged, CREATE_FAILED_RESPONSE, "rejected");
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
    const commandId = CommandId.make(yield* crypto.randomUUIDv4());
    const messageId = MessageId.make(yield* crypto.randomUUIDv4());
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
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
        commandId,
        threadId: thread.id,
        messageId,
        text: buildJiraTurnPrompt(input.invocation),
        attachments: [],
        modelSelection: thread.modelSelection,
        titleSeed: input.invocation.prompt.slice(0, 80) || "Jira comment",
        source,
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

  /**
   * Top-level comment on the bug. There is no triggering comment to thread under.
   * Team mentions are ADF nodes. A failed review passes an empty mention list.
   */
  const postBugJira = Effect.fn("JiraIssueBridge.postBugJira")(function* (
    delivery: StoredJiraDelivery,
    text: string,
    mentions: ReadonlyArray<JiraAdfMention>,
  ) {
    const trimmed = text.trim();
    if (trimmed.length === 0) return true;
    const prepared = partitionJiraComment(trimmed);
    const notice =
      prepared.overflow === null ? null : yield* storeOverflow(delivery, prepared.overflow);
    const inline = [prepared.inline, notice]
      .filter((part): part is string => part !== null && part.trim().length > 0)
      .join("\n\n");
    const body = formatJiraComment(
      appendJiraT3ThreadLink(
        inline,
        delivery.threadId === null
          ? null
          : {
              hostedAppUrl,
              environmentId,
              threadId: delivery.threadId,
            },
      ),
    );
    if (body.length === 0) return true;
    const posted = yield* jira.addIssueComment({
      issueKey: delivery.issueKey,
      body,
      parentCommentId: null,
      mentions,
    });
    if (posted === null) {
      yield* Effect.logError("Failed to post Jira bug update on the issue", {
        issueKey: delivery.issueKey,
      });
      return false;
    }
    return true;
  });

  /**
   * Watch a bug-report turn. Analysis and fix are commented on the Jira issue.
   * The mapped team is mentioned on each of those comments, and not on a failure.
   */
  const watchBugReport = Effect.fn("JiraIssueBridge.watchBugReport")(function* (
    delivery: StoredJiraDelivery,
  ) {
    if (delivery.threadId === null) {
      yield* deliveries.put({
        ...delivery,
        status: "rejected",
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      });
      return;
    }

    const startedAt = yield* Clock.currentTimeMillis;
    const timeoutMs = config.enabled ? config.turnTimeoutMs : 0;
    let tracked: StoredJiraDelivery = delivery;
    let announced: BugMilestones = { analysis: null, fix: null };
    const people = yield* identity.listMapPeople();
    const teamMentions = teamJiraMentions(people);

    const publish = (text: string, mentions: boolean) =>
      postBugJira(tracked, text, mentions ? teamMentions : []);

    while ((yield* Clock.currentTimeMillis) - startedAt < timeoutMs) {
      const snapshot = yield* projection
        .getThreadDetailById(tracked.threadId as ThreadId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(snapshot)) {
        yield* publish("The review stopped before an analysis was ready.", false);
        yield* deliveries.put({
          deliveryId: tracked.deliveryId,
          issueKey: tracked.issueKey,
          projectKey: tracked.projectKey,
          sourceCommentId: tracked.sourceCommentId,
          replyToCommentId: tracked.replyToCommentId,
          commentSurface: tracked.commentSurface,
          responseCommentId: tracked.responseCommentId,
          acknowledgmentEmojiId: tracked.acknowledgmentEmojiId,
          actorAccountId: tracked.actorAccountId,
          actorDisplayName: tracked.actorDisplayName,
          threadId: tracked.threadId,
          previousTurnId: tracked.previousTurnId,
          userMessageId: tracked.userMessageId,
          targetTurnId: tracked.targetTurnId,
          status: "rejected",
          createdAt: tracked.createdAt,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          kind: tracked.kind,
          discordThreadId: tracked.discordThreadId,
        });
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
          deliveryId: tracked.deliveryId,
          issueKey: tracked.issueKey,
          projectKey: tracked.projectKey,
          sourceCommentId: tracked.sourceCommentId,
          replyToCommentId: tracked.replyToCommentId,
          commentSurface: tracked.commentSurface,
          responseCommentId: tracked.responseCommentId,
          acknowledgmentEmojiId: tracked.acknowledgmentEmojiId,
          actorAccountId: tracked.actorAccountId,
          actorDisplayName: tracked.actorDisplayName,
          threadId: tracked.threadId,
          previousTurnId: tracked.previousTurnId,
          userMessageId: tracked.userMessageId,
          targetTurnId: discoveredTurnId as TurnId,
          status: tracked.status,
          createdAt: tracked.createdAt,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          kind: tracked.kind,
          discordThreadId: tracked.discordThreadId,
        };
        yield* deliveries.put(tracked);
      }

      const assistantTexts =
        discoveredTurnId === null
          ? []
          : thread.messages
              .filter(
                (message) =>
                  message.role === "assistant" &&
                  !message.streaming &&
                  message.turnId === discoveredTurnId,
              )
              .map((message) => message.text);
      const milestones = collectBugMilestones(assistantTexts);
      if (milestones.analysis !== null && announced.analysis === null) {
        if (yield* publish(milestones.analysis, true)) {
          announced = { analysis: milestones.analysis, fix: announced.fix };
        }
      }
      if (milestones.fix !== null && announced.fix === null) {
        if (yield* publish(milestones.fix, true)) {
          announced = { analysis: announced.analysis, fix: milestones.fix };
        }
      }

      const outcome = resolveGitHubBridgeTurnOutcome(thread, {
        ...resolveOptions,
        knownTargetTurnId: tracked.targetTurnId,
      });
      if (outcome._tag === "terminal") {
        const finalMilestones = fallbackBugMilestones({
          announced,
          finalText: outcome.status === "completed" ? outcome.body : "",
        });
        if (finalMilestones.analysis !== null && announced.analysis === null) {
          if (yield* publish(finalMilestones.analysis, true)) {
            announced = { analysis: finalMilestones.analysis, fix: announced.fix };
          }
        }
        if (finalMilestones.fix !== null && announced.fix === null) {
          yield* publish(finalMilestones.fix, true);
        }
        if (outcome.status !== "completed" && announced.analysis === null) {
          yield* publish("The review stopped before an analysis was ready.", false);
        }
        yield* deliveries.put({
          ...tracked,
          status: outcome.status === "completed" ? "completed" : "rejected",
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        return;
      }

      yield* Effect.sleep("1 second");
    }

    yield* deliveries.put({
      ...tracked,
      status: "completed",
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    });
  });

  const handleBugUnsafe = Effect.fn("JiraIssueBridge.handleBug")(function* (input: {
    readonly deliveryId: string;
    readonly report: JiraBugReport;
  }) {
    if (!config.enabled) return;
    const report = input.report;
    if (!isJiraProjectAllowed(config.allowedProjects, report.projectKey)) return;
    if (!config.projectMap.has(report.projectKey)) return;

    const botAccountId = config.botAccountId?.trim().toLowerCase() ?? "";
    const reporterAccountId = report.reporterAccountId?.trim().toLowerCase() ?? "";
    if (botAccountId.length > 0 && reporterAccountId === botAccountId) {
      yield* Effect.logInfo("Ignoring Jira bug created by the bot account", {
        issueKey: report.issueKey,
      });
      return;
    }

    const now = DateTime.formatIso(yield* DateTime.now);
    const initial: StoredJiraDelivery = {
      deliveryId: input.deliveryId,
      issueKey: report.issueKey,
      projectKey: report.projectKey,
      sourceCommentId: `issue-created:${report.issueId}`,
      replyToCommentId: `issue-created:${report.issueId}`,
      commentSurface: "issue",
      responseCommentId: null,
      acknowledgmentEmojiId: null,
      actorAccountId: report.reporterAccountId,
      actorDisplayName: report.reporterDisplayName,
      threadId: null,
      previousTurnId: null,
      userMessageId: null,
      targetTurnId: null,
      status: "received",
      createdAt: now,
      updatedAt: now,
      kind: "bug-report",
      discordThreadId: null,
    };
    if (!(yield* deliveries.claim(initial))) return;

    yield* Effect.logInfo("Accepted Jira bug report", {
      deliveryId: input.deliveryId,
      issueKey: report.issueKey,
      projectKey: report.projectKey,
    });

    const thread = yield* createThreadForIssue({
      issueKey: report.issueKey,
      issueSummary: report.summary,
      projectKey: report.projectKey,
    });
    if (thread === null) {
      yield* postBugJira(initial, "The review did not start.", []);
      yield* deliveries.put({
        ...initial,
        status: "rejected",
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      });
      return;
    }

    yield* workItems
      .appendForThread({
        threadId: thread.id,
        jiraIssueKeys: [report.issueKey],
        source: "jira-webhook",
      })
      .pipe(Effect.ignore);

    const commandId = CommandId.make(yield* crypto.randomUUIDv4());
    const messageId = MessageId.make(yield* crypto.randomUUIDv4());
    const processing: StoredJiraDelivery = {
      ...initial,
      threadId: thread.id,
      previousTurnId: thread.latestTurn?.turnId ?? null,
      userMessageId: messageId,
      status: "processing",
      updatedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* deliveries.put(processing);

    const mapPeople = yield* identity.listMapPeople();
    const source = buildIntegrationSourceRef({
      people: mapPeople,
      channel: "jira",
      platformId: report.reporterAccountId,
      displayName: report.reporterDisplayName,
      location: {
        projectKey: report.projectKey,
        issueKey: report.issueKey,
      },
    });
    const dispatched = yield* engine
      .dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
        commandId,
        threadId: thread.id,
        messageId,
        text: buildJiraBugReportPrompt(report),
        attachments: [],
        modelSelection: thread.modelSelection,
        titleSeed: report.summary?.slice(0, 80) || report.issueKey,
        source,
      })
      .pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logError("Failed to dispatch Jira bug report", {
            issueKey: report.issueKey,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
    if (!dispatched) {
      yield* postBugJira(processing, "The review did not start.", []);
      yield* deliveries.put({
        ...processing,
        status: "rejected",
        updatedAt: DateTime.formatIso(yield* DateTime.now),
      });
      return;
    }

    yield* Effect.forkDetach(
      watchBugReport(processing).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("Jira bug report watch stopped", {
            deliveryId: processing.deliveryId,
            issueKey: report.issueKey,
            cause,
          }),
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

  const handleBug = (input: { readonly deliveryId: string; readonly report: JiraBugReport }) =>
    handleBugUnsafe(input).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Jira bug report failed", {
          deliveryId: input.deliveryId,
          issueKey: input.report.issueKey,
          cause,
        }),
      ),
    );

  const restore = deliveries.listProcessing().pipe(
    Effect.flatMap((pending) =>
      Effect.forEach(
        pending,
        (delivery) =>
          Effect.forkDetach(
            delivery.kind === "bug-report" ? watchBugReport(delivery) : bridgeTurn(delivery),
          ),
        {
          concurrency: 4,
          discard: true,
        },
      ),
    ),
  );
  if (config.enabled) yield* restore;

  return JiraIssueBridge.of({ handle, handleBug });
});

export const layer = Layer.effect(JiraIssueBridge, make);
