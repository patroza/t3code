import {
  scopeProjectRef,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type { EnvironmentId, VcsStatusResult } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  CloudIcon,
  FolderGit2Icon,
  FolderPlusIcon,
  GitPullRequestIcon,
  TerminalIcon,
} from "lucide-react";
import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useEnvironment, usePrimaryEnvironmentId } from "../state/environments";
import { useProject } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { useThreadRunningTerminalIds } from "../state/terminalSessions";
import { vcsEnvironment } from "../state/vcs";
import { useUiStateStore } from "../uiStateStore";
import { connectionAtomRuntime } from "../connection/runtime";
import { resolveChangeRequestPresentation } from "../sourceControlPresentation";
import { resolveThreadStatusPill, type ThreadStatusPill } from "./Sidebar.logic";
import type { SidebarThreadSummary } from "../types";
import { formatWorktreePathForDisplay } from "../worktreeCleanup";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export interface PrStatusIndicator {
  label: string;
  colorClass: string;
  tooltip: string;
  url: string;
}

export interface TerminalStatusIndicator {
  label: "Terminal process running";
  colorClass: string;
  pulse: boolean;
}

export type ThreadPr = VcsStatusResult["pr"];

export function prStatusIndicator(
  pr: ThreadPr,
  provider: VcsStatusResult["sourceControlProvider"] | null | undefined,
): PrStatusIndicator | null {
  if (!pr) return null;
  const presentation = resolveChangeRequestPresentation(provider);

  if (pr.state === "open") {
    return {
      label: `${presentation.shortName} open`,
      colorClass: "text-emerald-600 dark:text-emerald-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} open: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "closed") {
    return {
      label: `${presentation.shortName} closed`,
      colorClass: "text-zinc-500 dark:text-zinc-400/80",
      tooltip: `#${pr.number} ${presentation.shortName} closed: ${pr.title}`,
      url: pr.url,
    };
  }
  if (pr.state === "merged") {
    return {
      label: `${presentation.shortName} merged`,
      colorClass: "text-violet-600 dark:text-violet-300/90",
      tooltip: `#${pr.number} ${presentation.shortName} merged: ${pr.title}`,
      url: pr.url,
    };
  }
  return null;
}

export function ChangeRequestStatusIcon({ className }: { className?: string }) {
  return <GitPullRequestIcon className={className} />;
}

export function resolveThreadPr(
  threadBranch: string | null,
  gitStatus: VcsStatusResult | null,
): ThreadPr | null {
  if (threadBranch === null || gitStatus === null) {
    return null;
  }

  const pr = gitStatus.pr ?? null;
  if (!pr) {
    return null;
  }

  if (gitStatus.refName === threadBranch || pr.headRef === threadBranch) {
    return pr;
  }

  return null;
}

const PR_STATUS_DEBUG = false;

export function usePrStatusIndicator(input: {
  environmentId: EnvironmentId | null;
  branch: string | null;
  gitCwd: string | null;
}): PrStatusIndicator | null {
  // Primary source: the live `vcs.status` subscription for this checkout. It is
  // the same warm stream the git-actions toolbar relies on, so the common case
  // — the thread's branch is the checkout's live branch — resolves immediately
  // without depending on the per-branch query path. `resolveThreadPr` already
  // accepts a PR whose `headRef` matches the thread branch even when the live
  // ref differs, which covers the "thread branch differs from live checkout"
  // case too as long as the worktree's PR resolution includes it.
  const liveStatus = useEnvironmentQuery(
    input.environmentId !== null && input.branch != null && input.gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: input.environmentId,
          input: { cwd: input.gitCwd },
        })
      : null,
  );
  const livePr = resolveThreadPr(input.branch, liveStatus.data);
  const liveProvider = liveStatus.data?.sourceControlProvider;

  // Secondary source: a per-branch change-request lookup. This is required for
  // threads whose branch was never the live ref of this checkout (e.g. a shared
  // worktree that has since moved on, but a thread still boxes an older branch
  // that had its own PR). It is also the only signal for the consensus logic in
  // grouped rows where members truly represent different branches.
  const branchPrQuery = useEnvironmentQuery(
    input.environmentId !== null && input.branch != null && input.gitCwd !== null
      ? vcsEnvironment.resolveBranchChangeRequest({
          environmentId: input.environmentId,
          input: { cwd: input.gitCwd, refName: input.branch },
        })
      : null,
  );

  if (PR_STATUS_DEBUG) {
    // eslint-disable-next-line no-console
    console.debug("[pr-status]", {
      environmentId: input.environmentId,
      branch: input.branch,
      gitCwd: input.gitCwd,
      liveRefName: liveStatus.data?.refName ?? null,
      livePr: livePr,
      branchQueryData: branchPrQuery.data,
    });
  }

  if (livePr) {
    return prStatusIndicator(livePr, liveProvider);
  }
  return prStatusIndicator(
    branchPrQuery.data?.pr ?? null,
    branchPrQuery.data?.sourceControlProvider,
  );
}

/**
 * Equality key for a {@link PrStatusIndicator}. Two threads share the same PR
 * status when they resolve to the same change request (number + state) or both
 * resolve to no indicator at all. This is what lets a sidebar worktree group
 * decide whether to roll the PR icon up onto the group header (all members
 * agree) or fall back to per-member indicators (any member differs).
 */
export function prIndicatorKey(indicator: PrStatusIndicator | null): string {
  if (indicator === null) {
    return "none";
  }
  return `${indicator.url}|${indicator.label}`;
}

export interface ThreadGroupPrConsensus {
  /**
   * Per-thread indicators, aligned with the input thread order. Resolution may
   * still be in-flight, in which case an entry is null until it settles.
   */
  readonly indicators: ReadonlyArray<PrStatusIndicator | null>;
  /**
   * `true` when every resolved member shares the same PR status. Empty groups
   * and fully-unresolved groups are treated as agreeing on `null`.
   */
  readonly allSame: boolean;
  /**
   * The shared indicator to render on the group header when {@link allSame} is
   * `true`; `null` otherwise (members render their own indicators).
   */
  readonly shared: PrStatusIndicator | null;
}

export function computeGroupPrConsensus(
  indicators: ReadonlyArray<PrStatusIndicator | null>,
): ThreadGroupPrConsensus {
  if (indicators.length === 0) {
    return { indicators, allSame: true, shared: null };
  }
  const firstKey = prIndicatorKey(indicators[0] ?? null);
  const allSame = indicators.every((indicator) => prIndicatorKey(indicator) === firstKey);
  return {
    indicators,
    allSame,
    shared: allSame ? (indicators[0] ?? null) : null,
  };
}

// Sidebar groups share a single worktree/checkout path, so members use the same
// `cwd` and differ only by `refName`. The derived consensus atom reads one
// per-branch change request atom per member and recomputes whenever any of
// them settle, letting the group header and member rows stay in sync without
// ad-hoc hooks-per-thread (which would break React's rules-of-hooks when group
// membership changes).
const threadGroupPrStatusAtomFamily = Atom.family((serializedKey: string) => {
  const separatorIndex = serializedKey.indexOf("\u0000");
  const environmentId = separatorIndex === -1 ? undefined : serializedKey.slice(0, separatorIndex);
  const remainder = separatorIndex === -1 ? "" : serializedKey.slice(separatorIndex + 1);
  const nextSeparatorIndex = remainder.indexOf("\u0000");
  const cwd = nextSeparatorIndex === -1 ? undefined : remainder.slice(0, nextSeparatorIndex);
  const refNamesCsv = nextSeparatorIndex === -1 ? "" : remainder.slice(nextSeparatorIndex + 1);
  const refNames = refNamesCsv.split("\u0001");
  // The family is only ever fed well-formed keys built by `useThreadGroupPrStatus`,
  // which guards on null `environmentId`/`cwd` before serializing, so the parsed
  // segments are always present at runtime.
  const resolvedEnvironmentId = environmentId as EnvironmentId;
  const resolvedCwd = cwd as string;
  return connectionAtomRuntime
    .atom((get) => {
      // One shared live-status subscription for the whole checkout (members share
      // a `cwd`). This is the same warm stream the git-actions toolbar uses, so it
      // resolves reliably for the common case where a member's branch is the live
      // ref. We only fall back to a per-branch change-request lookup for members
      // whose branch the live status does not cover.
      const sharedStatusAtom = vcsEnvironment.status({
        environmentId: resolvedEnvironmentId,
        input: { cwd: resolvedCwd },
      });
      const sharedStatus = Option.getOrNull(AsyncResult.value(get(sharedStatusAtom)));
      const sharedProvider = sharedStatus?.sourceControlProvider;

      const indicators: Array<PrStatusIndicator | null> = refNames.map((refName) => {
        if (refName.length === 0) {
          return null;
        }
        const livePr = resolveThreadPr(refName, sharedStatus ?? null);
        if (livePr) {
          return prStatusIndicator(livePr, sharedProvider);
        }
        const branchAtom = vcsEnvironment.resolveBranchChangeRequest({
          environmentId: resolvedEnvironmentId,
          input: { cwd: resolvedCwd, refName },
        });
        const settled = Option.getOrNull(AsyncResult.value(get(branchAtom)));
        return prStatusIndicator(settled?.pr ?? null, settled?.sourceControlProvider);
      });
      return Effect.succeed(computeGroupPrConsensus(indicators));
    })
    .pipe(Atom.withLabel(`thread-group-pr-status:${environmentId}:${cwd}:${refNamesCsv}`));
});

const EMPTY_GROUP_PR_CONSENSUS: ThreadGroupPrConsensus = {
  indicators: [],
  allSame: true,
  shared: null,
};

const EMPTY_GROUP_PR_STATUS_ATOM = Atom.make(
  AsyncResult.success<ThreadGroupPrConsensus>(EMPTY_GROUP_PR_CONSENSUS),
).pipe(Atom.keepAlive, Atom.withLabel("thread-group-pr-status:empty"));

/**
 * Resolves per-branch PR status for every thread in a sidebar worktree group and
 * derives whether the group can show a single rolled-up indicator or must defer
 * to per-member indicators. The returned indicators line up with the input
 * `threads` order so callers can hand them straight to member rows.
 */
export function useThreadGroupPrStatus(input: {
  environmentId: EnvironmentId | null;
  cwd: string | null;
  threads: ReadonlyArray<Pick<SidebarThreadSummary, "branch">>;
}): ThreadGroupPrConsensus {
  const serializedKey =
    input.environmentId !== null && input.cwd !== null
      ? `${input.environmentId}\u0000${input.cwd}\u0000${input.threads.map((thread) => thread.branch ?? "").join("\u0001")}`
      : null;
  const atom = serializedKey !== null ? threadGroupPrStatusAtomFamily(serializedKey) : null;
  const result = useAtomValue(atom ?? EMPTY_GROUP_PR_STATUS_ATOM);
  const settled = Option.getOrNull(AsyncResult.value(result));
  return settled ?? EMPTY_GROUP_PR_CONSENSUS;
}

export function terminalStatusFromRunningIds(
  runningTerminalIds: ReadonlyArray<string>,
): TerminalStatusIndicator | null {
  if (runningTerminalIds.length === 0) {
    return null;
  }
  return {
    label: "Terminal process running",
    colorClass: "text-teal-600 dark:text-teal-300/90",
    pulse: true,
  };
}

export function ThreadWorktreeIndicator({
  thread,
  onCreateSession,
}: {
  thread: Pick<SidebarThreadSummary, "id" | "branch" | "worktreePath">;
  onCreateSession?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const worktreePath = thread.worktreePath?.trim();
  if (!worktreePath && !onCreateSession) {
    return null;
  }

  const tooltip = worktreePath
    ? thread.branch
      ? `Worktree: ${formatWorktreePathForDisplay(worktreePath)} (${thread.branch})`
      : `Worktree: ${formatWorktreePathForDisplay(worktreePath)}`
    : thread.branch
      ? `New worktree from ${thread.branch}`
      : "New worktree";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          onCreateSession ? (
            <button
              type="button"
              aria-label={worktreePath ? "New session on this worktree" : tooltip}
              data-testid={`thread-worktree-new-session-${thread.id}`}
              className="inline-flex cursor-pointer items-center justify-center rounded-sm text-muted-foreground/55 outline-hidden transition-colors hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
              onPointerDown={(event) => {
                event.stopPropagation();
              }}
              onClick={onCreateSession}
            />
          ) : (
            <span
              role="img"
              aria-label={tooltip}
              data-testid={`thread-worktree-${thread.id}`}
              className="inline-flex items-center justify-center"
            />
          )
        }
      >
        {onCreateSession ? (
          <FolderPlusIcon className="size-3" />
        ) : (
          <FolderGit2Icon className="size-3 text-muted-foreground/40" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function ThreadStatusLabel({
  status,
  compact = false,
}: {
  status: ThreadStatusPill;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              aria-label={status.label}
              className={`inline-flex size-3.5 shrink-0 items-center justify-center ${status.colorClass}`}
            />
          }
        >
          <span
            className={`size-[9px] rounded-full ${status.dotClass} ${
              status.pulse ? "animate-status-pulse" : ""
            }`}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{status.label}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={status.label}
            className={`inline-flex items-center gap-1 text-[10px] ${status.colorClass}`}
          />
        }
      >
        <span
          className={`h-1.5 w-1.5 rounded-full ${status.dotClass} ${
            status.pulse ? "animate-status-pulse" : ""
          }`}
        />
        <span className="hidden md:inline">{status.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Non-interactive leading status icons for a thread row in compact contexts
 * like the command palette. Shows the change request state icon (if present) and the
 * thread status dot, matching the sidebar's leading indicators.
 */
export function ThreadRowLeadingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[scopedThreadKey(threadRef)],
  );
  const threadProject = useProject(
    useMemo(
      () => scopeProjectRef(thread.environmentId, thread.projectId),
      [thread.environmentId, thread.projectId],
    ),
  );
  const threadProjectCwd = threadProject?.workspaceRoot ?? null;
  const gitCwd = thread.worktreePath ?? threadProjectCwd;
  const prStatus = usePrStatusIndicator({
    environmentId: thread.environmentId,
    branch: thread.branch,
    gitCwd,
  });
  const threadStatus = resolveThreadStatusPill({
    thread: {
      ...thread,
      lastVisitedAt,
    },
  });

  if (!prStatus && !threadStatus) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {prStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={prStatus.tooltip}
                className={`inline-flex items-center justify-center ${prStatus.colorClass}`}
              />
            }
          >
            <ChangeRequestStatusIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">{prStatus.tooltip}</TooltipPopup>
        </Tooltip>
      ) : null}
      {threadStatus ? <ThreadStatusLabel status={threadStatus} /> : null}
    </span>
  );
}

/**
 * Non-interactive trailing status icons for a thread row in compact contexts
 * like the command palette. Shows a terminal-running indicator and a remote
 * environment indicator, matching the sidebar's trailing indicators.
 */
export function ThreadRowTrailingStatus({ thread }: { thread: SidebarThreadSummary }) {
  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const environment = useEnvironment(thread.environmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isRemoteThread =
    primaryEnvironmentId !== null && thread.environmentId !== primaryEnvironmentId;
  const remoteEnvLabel = environment?.label ?? null;
  const threadEnvironmentLabel = isRemoteThread ? (remoteEnvLabel ?? "Remote") : null;
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  if (!terminalStatus && !isRemoteThread) {
    return null;
  }

  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      {terminalStatus ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={terminalStatus.label}
                className={`inline-flex items-center justify-center ${terminalStatus.colorClass}`}
              />
            }
          >
            <TerminalIcon
              className={`size-3 ${terminalStatus.pulse ? "animate-status-pulse" : ""}`}
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{terminalStatus.label}</TooltipPopup>
        </Tooltip>
      ) : null}
      {isRemoteThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                aria-label={threadEnvironmentLabel ?? "Remote"}
                className="inline-flex items-center justify-center"
              />
            }
          >
            <CloudIcon className="size-3 text-muted-foreground/60" />
          </TooltipTrigger>
          <TooltipPopup side="top">{threadEnvironmentLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
