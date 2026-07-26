// @effect-diagnostics globalFetch:off globalFetchInEffect:off unknownInEffectCatch:off anyUnknownInErrorContext:off outdatedApi:off
import type { ProjectId, ThreadId } from "@t3tools/contracts";
import { DiscordConfig, DiscordREST } from "dfx";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

import type { DiscordBotConfig } from "../config.ts";
import { resolveGitHubUrlForWorkspace } from "../presentation/githubLinks.ts";
import {
  extractJiraIssueKeysFromDiscordMessage,
  mergeJiraIssueKeys,
} from "../presentation/jiraLinks.ts";
import {
  extractPullRequestUrlsFromDiscordMessage,
  mergePullRequestUrls,
  normalizeGithubRepoSlug,
} from "../presentation/prLinks.ts";
import {
  applyModelHistoryUpdate,
  formatModelSelectionLine,
  formatThreadInfoModelLine,
  isThreadInfoPinContent,
  renderThreadInfoPin,
  type ThreadInfoPinRenderInput,
  type ThreadModelHistory,
} from "../presentation/threadInfoPin.ts";
import { ThreadLinkStore, type ThreadLink } from "../store/ThreadLinkStore.ts";
import { T3Session } from "../t3/T3Session.ts";

interface DiscordMessageSummary {
  readonly id: string;
  readonly content?: string | null;
  readonly embeds?: ReadonlyArray<{
    readonly url?: string | null;
    readonly title?: string | null;
    readonly description?: string | null;
    readonly footer?: { readonly text?: string | null } | null;
  }> | null;
  readonly author?: { readonly id?: string; readonly bot?: boolean } | null;
  readonly timestamp?: string | null;
}

export interface ThreadInfoPinMessageRef {
  readonly channelId: string;
  readonly messageId: string;
  readonly jiraIssueKeys: ReadonlyArray<string>;
  readonly prUrls: ReadonlyArray<string>;
}

async function discordApiJson<T>(input: {
  readonly baseUrl: string;
  readonly botToken: string;
  readonly path: string;
  readonly method?: string;
  readonly body?: unknown;
}): Promise<T> {
  const response = await globalThis.fetch(`${input.baseUrl.replace(/\/+$/u, "")}${input.path}`, {
    method: input.method ?? "GET",
    headers: {
      Authorization: `Bot ${input.botToken}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
    },
    ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Discord API ${input.method ?? "GET"} ${input.path} failed (${response.status}): ${body}`,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

async function discordApiVoid(input: {
  readonly baseUrl: string;
  readonly botToken: string;
  readonly path: string;
  readonly method: string;
}): Promise<void> {
  const response = await globalThis.fetch(`${input.baseUrl.replace(/\/+$/u, "")}${input.path}`, {
    method: input.method,
    headers: {
      Authorization: `Bot ${input.botToken}`,
      "User-Agent": "DiscordBot (t3-discord-bot, 0.0.0)",
    },
  });
  if (!response.ok && response.status !== 204) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Discord API ${input.method} ${input.path} failed (${response.status}): ${body}`,
    );
  }
}

function t3WebThreadUrl(webUiBaseUrl: string | undefined, threadId: string): string | null {
  if (webUiBaseUrl === undefined) return null;
  return `${webUiBaseUrl.replace(/\/$/u, "")}/?thread=${threadId}`;
}

export function modelHistoryFromLink(
  link:
    | Pick<ThreadLink, "initialModelLine" | "currentModelLine" | "modelSinceAt">
    | null
    | undefined,
): ThreadModelHistory {
  return {
    initialModelLine: link?.initialModelLine ?? null,
    currentModelLine: link?.currentModelLine ?? null,
    modelSinceAt: link?.modelSinceAt ?? null,
  };
}

export function buildThreadInfoRenderInput(input: {
  readonly modelSelection?:
    | { readonly instanceId: string; readonly model: string }
    | null
    | undefined;
  /** When set, preferred over a bare modelSelection line (includes since/started-with). */
  readonly modelHistory?: ThreadModelHistory | null | undefined;
  readonly worktreePath?: string | null | undefined;
  readonly baseBranchLabel?: string | null | undefined;
  readonly local?: boolean | undefined;
  readonly webLink?: string | null | undefined;
  readonly extraLines?: ReadonlyArray<string | null | undefined> | undefined;
  readonly jiraIssueKeys?: ReadonlyArray<string> | undefined;
  readonly jiraBrowseBaseUrl?: string | undefined;
  readonly prUrls?: ReadonlyArray<string> | undefined;
  readonly channelGithubRepoSlug?: string | null | undefined;
  readonly titleLine?: string | null | undefined;
}): ThreadInfoPinRenderInput {
  const modelLineFromHistory =
    input.modelHistory === null || input.modelHistory === undefined
      ? null
      : formatThreadInfoModelLine(input.modelHistory);
  const modelLine =
    modelLineFromHistory ??
    (input.modelSelection === null || input.modelSelection === undefined
      ? null
      : formatModelSelectionLine(input.modelSelection));

  let worktreeLine: string | null = null;
  if (input.local === true) {
    worktreeLine = "Mode: local (no worktree)";
  } else if (input.worktreePath !== null && input.worktreePath !== undefined) {
    worktreeLine = `Worktree: \`${input.worktreePath}\``;
  } else if (input.baseBranchLabel !== null && input.baseBranchLabel !== undefined) {
    worktreeLine = `Worktree off \`${input.baseBranchLabel}\``;
  }

  return {
    modelLine,
    worktreeLine,
    webLink: input.webLink ?? null,
    extraLines: [...(input.titleLine ? [input.titleLine] : []), ...(input.extraLines ?? [])],
    jiraIssueKeys: input.jiraIssueKeys ?? [],
    jiraBrowseBaseUrl: input.jiraBrowseBaseUrl,
    prUrls: input.prUrls ?? [],
    channelGithubRepoSlug: input.channelGithubRepoSlug ?? null,
  };
}

/**
 * Resolve the channel/project GitHub `owner/repo` for PR label disambiguation.
 * Prefers the thread worktree, then the linked project workspace root.
 */
const resolveChannelGithubRepoSlug = (input: {
  readonly worktreePath?: string | null | undefined;
  readonly projectId?: ProjectId | string | null | undefined;
}) =>
  Effect.gen(function* () {
    const t3 = yield* T3Session;
    let cwd =
      input.worktreePath !== null &&
      input.worktreePath !== undefined &&
      input.worktreePath.trim() !== ""
        ? input.worktreePath
        : null;

    if (cwd === null && input.projectId !== null && input.projectId !== undefined) {
      const project = yield* t3.getProjectShell(input.projectId as ProjectId);
      const root = project?.workspaceRoot?.trim() ?? "";
      cwd = root.length > 0 ? root : null;
    }

    if (cwd === null) return null;

    const githubUrl = yield* Effect.tryPromise({
      try: () => resolveGitHubUrlForWorkspace(cwd),
      catch: () => null as string | null,
    }).pipe(Effect.orElseSucceed(() => null as string | null));

    return normalizeGithubRepoSlug(githubUrl);
  });

/**
 * Create or update the pinned thread-info message and ensure it stays pinned.
 */
export const ensureThreadInfoPin = (input: {
  readonly channelId: string;
  readonly content: string;
  readonly existingMessageId?: string | null;
}) =>
  Effect.gen(function* () {
    const discordConfig = yield* DiscordConfig.DiscordConfig;
    const botToken = Redacted.value(discordConfig.token);
    const baseUrl = discordConfig.rest.baseUrl;

    const pinned = yield* Effect.tryPromise({
      try: () =>
        discordApiJson<ReadonlyArray<DiscordMessageSummary>>({
          baseUrl,
          botToken,
          path: `/channels/${input.channelId}/pins`,
        }),
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed((): ReadonlyArray<DiscordMessageSummary> => []));

    const infoPins = pinned.filter((message) => isThreadInfoPinContent(message.content));
    const existingFromPins = infoPins[0] ?? null;
    const stale = infoPins.slice(1);

    let messageId =
      input.existingMessageId && input.existingMessageId.trim() !== ""
        ? input.existingMessageId
        : (existingFromPins?.id ?? null);

    // Prefer the stored id when still present among pins or when it still exists.
    if (messageId !== null) {
      const patchOk = yield* Effect.tryPromise({
        try: () =>
          discordApiJson({
            baseUrl,
            botToken,
            path: `/channels/${input.channelId}/messages/${messageId}`,
            method: "PATCH",
            body: { content: input.content },
          }),
        catch: (cause) => cause,
      }).pipe(
        Effect.as(true as const),
        Effect.orElseSucceed(() => false as const),
      );

      if (!patchOk) {
        messageId = existingFromPins?.id ?? null;
        if (messageId !== null) {
          yield* Effect.tryPromise({
            try: () =>
              discordApiJson({
                baseUrl,
                botToken,
                path: `/channels/${input.channelId}/messages/${messageId}`,
                method: "PATCH",
                body: { content: input.content },
              }),
            catch: (cause) => cause,
          });
        }
      }
    }

    if (messageId === null) {
      const created = yield* Effect.tryPromise({
        try: () =>
          discordApiJson<{ readonly id: string }>({
            baseUrl,
            botToken,
            path: `/channels/${input.channelId}/messages`,
            method: "POST",
            body: { content: input.content },
          }),
        catch: (cause) => cause,
      });
      messageId = created.id;
    }

    // Ensure pin (idempotent PUT).
    yield* Effect.tryPromise({
      try: () =>
        discordApiVoid({
          baseUrl,
          botToken,
          path: `/channels/${input.channelId}/pins/${messageId}`,
          method: "PUT",
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Failed to pin thread info message", {
          channelId: input.channelId,
          messageId,
          error: String(error),
        }),
      ),
    );

    for (const message of stale) {
      if (message.id === messageId) continue;
      yield* Effect.tryPromise({
        try: () =>
          discordApiVoid({
            baseUrl,
            botToken,
            path: `/channels/${input.channelId}/pins/${message.id}`,
            method: "DELETE",
          }),
        catch: (cause) => cause,
      }).pipe(Effect.catch(() => Effect.void));
    }

    return {
      channelId: input.channelId,
      messageId,
    } as const;
  });

/**
 * Persist any newly observed Jira keys / PR URLs, then create/update + pin the thread-info message.
 */
export const upsertThreadInfoPin = (input: {
  readonly discordThreadId: string;
  readonly t3ThreadId: string;
  readonly botConfig: DiscordBotConfig;
  readonly incomingJiraKeys?: ReadonlyArray<string>;
  readonly incomingPrUrls?: ReadonlyArray<string>;
  readonly modelSelection?: { readonly instanceId: string; readonly model: string } | null;
  readonly worktreePath?: string | null;
  readonly baseBranchLabel?: string | null;
  readonly local?: boolean;
  /** Skip GitHub repo slug enrichment on latency-sensitive bootstrap paths. */
  readonly skipChannelRepoLookup?: boolean;
  readonly extraLines?: ReadonlyArray<string | null | undefined>;
  readonly titleLine?: string | null;
}) =>
  Effect.gen(function* () {
    const links = yield* ThreadLinkStore;
    const existing = yield* links.getByDiscordThreadId(input.discordThreadId);

    let jiraIssueKeys = mergeJiraIssueKeys(existing?.jiraIssueKeys, input.incomingJiraKeys ?? []);
    if ((input.incomingJiraKeys?.length ?? 0) > 0) {
      const updated = yield* links.appendJiraIssueKeys(
        input.discordThreadId,
        input.incomingJiraKeys ?? [],
      );
      if (updated !== null) {
        jiraIssueKeys = updated.jiraIssueKeys ?? jiraIssueKeys;
      }
    }

    let prUrls = mergePullRequestUrls(existing?.prUrls, input.incomingPrUrls ?? []);
    if ((input.incomingPrUrls?.length ?? 0) > 0) {
      const updated = yield* links.appendPrUrls(input.discordThreadId, input.incomingPrUrls ?? []);
      if (updated !== null) {
        prUrls = updated.prUrls ?? prUrls;
      }
    }

    const nextModelLine =
      input.modelSelection === null || input.modelSelection === undefined
        ? null
        : formatModelSelectionLine(input.modelSelection);
    const modelHistory = applyModelHistoryUpdate(modelHistoryFromLink(existing), nextModelLine);
    if (
      modelHistory.initialModelLine !== (existing?.initialModelLine ?? null) ||
      modelHistory.currentModelLine !== (existing?.currentModelLine ?? null) ||
      modelHistory.modelSinceAt !== (existing?.modelSinceAt ?? null)
    ) {
      yield* links.setModelHistory(input.discordThreadId, modelHistory);
    }

    const channelGithubRepoSlug =
      input.skipChannelRepoLookup === true
        ? null
        : yield* resolveChannelGithubRepoSlug({
            worktreePath: input.worktreePath,
            projectId: existing?.projectId,
          });

    const content = renderThreadInfoPin(
      buildThreadInfoRenderInput({
        modelSelection: input.modelSelection,
        modelHistory,
        worktreePath: input.worktreePath,
        baseBranchLabel: input.baseBranchLabel,
        local: input.local,
        webLink: t3WebThreadUrl(input.botConfig.webUiBaseUrl, input.t3ThreadId),
        extraLines: input.extraLines,
        titleLine: input.titleLine,
        jiraIssueKeys,
        jiraBrowseBaseUrl: input.botConfig.jiraBrowseBaseUrl,
        prUrls,
        channelGithubRepoSlug,
      }),
    );

    // After setModelHistory the stored info message id is still on `existing`.
    const latest = yield* links.getByDiscordThreadId(input.discordThreadId);
    const pin = yield* ensureThreadInfoPin({
      channelId: input.discordThreadId,
      content,
      existingMessageId: latest?.infoDiscordMessageId ?? existing?.infoDiscordMessageId ?? null,
    });

    if ((latest?.infoDiscordMessageId ?? existing?.infoDiscordMessageId) !== pin.messageId) {
      yield* links.setInfoDiscordMessageId(input.discordThreadId, pin.messageId);
    }

    return {
      channelId: pin.channelId,
      messageId: pin.messageId,
      jiraIssueKeys,
      prUrls,
    } satisfies ThreadInfoPinMessageRef;
  });

const BACKFILL_MESSAGE_PAGES = 5;
const BACKFILL_PAGE_SIZE = 100;
const BACKFILL_CONCURRENCY = 2;

/**
 * On bot start: scan linked Discord threads for Jira keys and PR URLs
 * (chronological first-seen), rewrite the thread-info message, and ensure it is pinned.
 */
export const backfillThreadInfoPins = (botConfig: DiscordBotConfig) =>
  Effect.gen(function* () {
    const links = yield* ThreadLinkStore;

    const all = yield* links.list();
    const active = all
      .filter((link) => link.status === "active")
      .toSorted((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt));

    yield* Effect.logInfo("Thread info pin backfill starting", {
      activeLinks: active.length,
      jiraBrowseBaseUrl: botConfig.jiraBrowseBaseUrl ?? "(unset)",
    });

    let updated = 0;
    let failed = 0;
    let skipped = 0;

    yield* Effect.forEach(
      active,
      (link) =>
        Effect.gen(function* () {
          const result = yield* backfillOneThreadInfoPin(link, botConfig).pipe(Effect.result);

          if (result._tag === "Failure") {
            failed += 1;
            yield* Effect.logWarning("Thread info pin backfill failed", {
              discordThreadId: link.discordThreadId,
              t3ThreadId: link.t3ThreadId,
              error: String(result.failure),
            });
            return;
          }
          if (result.success === "skipped") {
            skipped += 1;
            return;
          }
          updated += 1;
        }),
      { concurrency: BACKFILL_CONCURRENCY },
    );

    yield* Effect.logInfo("Thread info pin backfill finished", {
      considered: active.length,
      updated,
      skipped,
      failed,
    });
  });

const backfillOneThreadInfoPin = (link: ThreadLink, botConfig: DiscordBotConfig) =>
  Effect.gen(function* () {
    const rest = yield* DiscordREST;
    const t3 = yield* T3Session;
    const links = yield* ThreadLinkStore;

    const channelOk = yield* rest.getChannel(link.discordThreadId).pipe(
      Effect.as(true as const),
      Effect.orElseSucceed(() => false as const),
    );
    if (!channelOk) return "skipped" as const;

    const history = yield* fetchChannelMessagesOldestFirst(link.discordThreadId);

    const keysFromHistory: string[] = [];
    const prUrlsFromHistory: string[] = [];
    let discoveredInfoMessageId: string | null = link.infoDiscordMessageId ?? null;

    for (const message of history) {
      const keys = extractJiraIssueKeysFromDiscordMessage(message);
      for (const key of keys) keysFromHistory.push(key);
      const prUrls = extractPullRequestUrlsFromDiscordMessage(message);
      for (const url of prUrls) prUrlsFromHistory.push(url);
      if (discoveredInfoMessageId === null && isThreadInfoPinContent(message.content)) {
        discoveredInfoMessageId = message.id;
      }
    }

    const mergedKeys = mergeJiraIssueKeys(link.jiraIssueKeys, keysFromHistory);
    yield* links.setJiraIssueKeys(link.discordThreadId, mergedKeys);
    const mergedPrUrls = mergePullRequestUrls(link.prUrls, prUrlsFromHistory);
    yield* links.setPrUrls(link.discordThreadId, mergedPrUrls);
    if (discoveredInfoMessageId !== null && discoveredInfoMessageId !== link.infoDiscordMessageId) {
      yield* links.setInfoDiscordMessageId(link.discordThreadId, discoveredInfoMessageId);
    }

    const shell = yield* t3.getThreadShell(link.t3ThreadId as ThreadId);
    const modelSelection = shell?.modelSelection ?? null;
    const worktreePath = shell?.worktreePath ?? null;

    yield* upsertThreadInfoPin({
      discordThreadId: link.discordThreadId,
      t3ThreadId: link.t3ThreadId,
      botConfig,
      incomingJiraKeys: [],
      incomingPrUrls: [],
      modelSelection,
      worktreePath,
      local: worktreePath === null,
      // Keys/URLs already persisted via setJiraIssueKeys/setPrUrls; upsert merges from store.
    });

    return "updated" as const;
  });

const fetchChannelMessagesOldestFirst = (channelId: string) =>
  Effect.gen(function* () {
    const rest = yield* DiscordREST;
    const newestFirst: DiscordMessageSummary[] = [];
    let before: string | undefined;

    for (let page = 0; page < BACKFILL_MESSAGE_PAGES; page += 1) {
      const batch = (yield* rest
        .listMessages(channelId, {
          limit: BACKFILL_PAGE_SIZE,
          ...(before === undefined ? {} : { before }),
        })
        .pipe(
          Effect.orElseSucceed((): ReadonlyArray<DiscordMessageSummary> => []),
        )) as ReadonlyArray<DiscordMessageSummary>;

      if (batch.length === 0) break;
      newestFirst.push(...batch);
      before = batch[batch.length - 1]?.id;
      if (batch.length < BACKFILL_PAGE_SIZE) break;
    }

    // Discord returns newest-first; reverse for chronological first-seen key order.
    return newestFirst.toReversed();
  });
