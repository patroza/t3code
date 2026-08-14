import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ChangeRequestStateLike } from "@t3tools/client-runtime/state/thread-settled";
import { ChevronDownIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { AiUsageStats } from "./AiUsageStats";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { VisualStudioCode } from "../Icons";
import { readLocalApi } from "~/localApi";
import { useAiUsageSnapshot } from "../../hooks/useAiUsageSnapshot";
import { resolveDriverUsage, usageDotFillClass, usageDotRingColor } from "../../aiUsageState";
import { HostResourceStatus } from "../HostResourceStatus";
import { isLocalConnectionTarget } from "~/connection/desktopLocal";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  /** Drafts have no server thread yet, so the title carries no action menu. */
  isServerThread: boolean;
  /** PR state feeding the settled classification, resolved by ChatView. */
  changeRequestState: ChangeRequestStateLike | null;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  activeProjectFaviconPath: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  isPreparingWorktree?: boolean;
  /** For showing usage dot on the active thread's model at conversation level. */
  activeThreadDriverKind?: ProviderDriverKind | null;
  activeThreadModel?: string | null;
  readonly onOpenPullRequest?: ((number: number) => void) | undefined;
  onNewThreadInProject: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

/**
 * Rename commit rule shared with the sidebar's inline rename: trim, reject
 * empty (the caller toasts), and skip the mutation when nothing changed.
 */
export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

/**
 * Remote Open-in-VS-Code is mutually exclusive with the local OpenInPicker:
 * only offer it for a named project when the local picker is hidden (non-primary
 * environments). Pure gate so stack recovery cannot keep the URI helper while
 * dropping the product surface without a failing unit test.
 */
export function shouldOfferRemoteVscodeOpen(input: {
  readonly activeProjectName: string | undefined;
  readonly showOpenInPicker: boolean;
}): boolean {
  return Boolean(input.activeProjectName) && !input.showOpenInPicker;
}

function encodeRemotePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

export function resolveRemoteVscodeOpenTarget(input: {
  readonly entry: ConnectionCatalogEntry | null;
  readonly cwd: string | null;
}): { readonly authority: string; readonly uri: string } | null {
  if (!input.cwd || !input.cwd.startsWith("/")) return null;
  const entry = input.entry;
  if (!entry) return null;

  let hostname: string | null = null;
  let username: string | null = null;

  if (
    entry.target._tag === "SshConnectionTarget" &&
    Option.isSome(entry.profile) &&
    entry.profile.value._tag === "SshConnectionProfile"
  ) {
    hostname = entry.profile.value.target.hostname;
    username = entry.profile.value.target.username ?? username;
  } else if (
    entry.target._tag === "BearerConnectionTarget" &&
    Option.isSome(entry.profile) &&
    entry.profile.value._tag === "BearerConnectionProfile"
  ) {
    // The HTTP endpoint may be a gateway on a different machine. Remote-SSH must target
    // the environment itself, not the transport endpoint used to reach its T3 server.
    hostname = entry.profile.value.label.trim() || entry.target.label.trim() || null;
  }

  if (!hostname) return null;
  const authority = username ? `${username}@${hostname}` : hostname;
  // `windowId=_blank` focuses the window that already has this remote folder open, otherwise opens a
  // new one — instead of replacing whatever window is currently focused.
  const uri = `vscode://vscode-remote/ssh-remote+${encodeURIComponent(authority)}${encodeRemotePath(
    input.cwd,
  )}?windowId=_blank`;
  return { authority, uri };
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  isServerThread,
  changeRequestState,
  activeProjectName,
  activeProjectCwd,
  activeProjectFaviconPath,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  isPreparingWorktree = false,
  activeThreadDriverKind = null,
  activeThreadModel = null,
  onOpenPullRequest,
  onNewThreadInProject,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironment = useEnvironment(activeThreadEnvironmentId);
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const remoteVscodeTarget = useMemo(
    () =>
      shouldOfferRemoteVscodeOpen({ activeProjectName, showOpenInPicker })
        ? resolveRemoteVscodeOpenTarget({
            entry: activeEnvironment?.entry ?? null,
            cwd: openInCwd,
          })
        : null,
    [activeEnvironment?.entry, activeProjectName, openInCwd, showOpenInPicker],
  );
  const openRemoteVscode = useCallback(() => {
    if (!remoteVscodeTarget) return;
    void readLocalApi()?.shell.openExternal(remoteVscodeTarget.uri);
  }, [remoteVscodeTarget]);

  const aiUsageSnapshot = useAiUsageSnapshot(activeThreadEnvironmentId);
  const headerUsage = useMemo(
    () => resolveDriverUsage(aiUsageSnapshot, activeThreadDriverKind, activeThreadModel),
    [aiUsageSnapshot, activeThreadDriverKind, activeThreadModel],
  );
  const headerDotClass = headerUsage ? usageDotFillClass(headerUsage.marker) : undefined;
  const headerRingColor = headerUsage ? usageDotRingColor(headerUsage.marker) : undefined;

  const activeThreadRef = useMemo(
    () => scopeThreadRef(activeThreadEnvironmentId, activeThreadId),
    [activeThreadEnvironmentId, activeThreadId],
  );
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  // Inline rename, keyed by thread: navigating away drops an in-progress
  // rename instead of committing stale text. Cleared on thread change (not
  // just hidden) so returning to the thread doesn't revive the old draft.
  const [renaming, setRenaming] = useState<{ threadId: ThreadId; title: string } | null>(null);
  if (renaming !== null && renaming.threadId !== activeThreadId) {
    setRenaming(null);
  }
  const renamingTitle = renaming?.threadId === activeThreadId ? renaming.title : null;
  const renameCommittedRef = useRef(false);
  const startRename = useCallback(() => {
    renameCommittedRef.current = false;
    setRenaming({ threadId: activeThreadId, title: activeThreadTitle });
  }, [activeThreadId, activeThreadTitle]);
  const commitRename = useCallback(
    (title: string) => {
      setRenaming(null);
      const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId: activeThreadEnvironmentId,
        input: { threadId: activeThreadId, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [activeThreadEnvironmentId, activeThreadId, activeThreadTitle, updateThreadMetadata],
  );
  const { openMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    changeRequestState,
    onStartRename: startRename,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const openMenuFromTitle = useCallback(() => {
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  }, [openMenu]);
  const handleHeaderContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!isServerThread || renamingTitle !== null) return;
      // The right-side controls (git, scripts, open-in) keep their own
      // behavior; only the breadcrumb area opens the thread menu.
      if ((event.target as HTMLElement).closest("[data-chat-header-actions]")) return;
      event.preventDefault();
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [isServerThread, openMenu, renamingTitle],
  );
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenaming(null);
      }
    },
    [commitRename],
  );
  return (
    <div
      className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3"
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb ariaLabel="Thread breadcrumb" className="flex-1">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <>
            <WorkspaceBreadcrumbItem>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`New thread in ${activeProjectName}`}
                      onClick={onNewThreadInProject}
                      className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  <ProjectFavicon
                    environmentId={activeThreadEnvironmentId}
                    cwd={activeProjectCwd ?? ""}
                    faviconPath={activeProjectFaviconPath}
                    className="size-3.5"
                  />
                  <span className="max-w-40 truncate">{activeProjectName}</span>
                </TooltipTrigger>
                <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current className="flex-1">
          {renamingTitle !== null ? (
            <input
              autoFocus
              aria-label="Thread title"
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    ref={titleButtonRef}
                    type="button"
                    aria-label={`Thread actions for ${activeThreadTitle}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <h2 className="min-w-0 truncate">{activeThreadTitle}</h2>
                <ChevronDownIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <h2 aria-label={activeThreadTitle} className="min-w-0 flex-1 truncate">
                    {activeThreadTitle}
                  </h2>
                }
              />
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          )}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {headerDotClass && headerUsage ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className={`inline-block size-2 shrink-0 rounded-full ${headerDotClass} cursor-help`}
                style={
                  headerRingColor
                    ? { boxShadow: `0 0 0 1.5px ${headerRingColor}, 0 0 0 3px var(--card)` }
                    : undefined
                }
                aria-label="provider usage status"
              />
            }
          />
          <TooltipPopup side="bottom" className="p-2 text-xs">
            <AiUsageStats item={headerUsage.item} />
          </TooltipPopup>
        </Tooltip>
      ) : headerDotClass ? (
        <span
          className={`inline-block size-2 shrink-0 rounded-full ${headerDotClass}`}
          style={
            headerRingColor
              ? { boxShadow: `0 0 0 1.5px ${headerRingColor}, 0 0 0 3px var(--card)` }
              : undefined
          }
          aria-label="provider usage status"
          title="Usage status for current model"
        />
      ) : null}
      <HostResourceStatus
        environmentId={activeThreadEnvironmentId}
        environmentLabel={activeEnvironment?.label ?? "Active environment"}
        connected={activeEnvironment?.connection.phase === "connected"}
        remote={
          activeEnvironment ? !isLocalConnectionTarget(activeEnvironment.entry.target) : false
        }
        className="hidden @2xl/header-actions:flex"
      />
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
      >
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            fileScripts={fileScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {remoteVscodeTarget && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={`Open in VS Code Remote SSH on ${remoteVscodeTarget.authority}`}
                  size="xs"
                  variant="outline"
                  onClick={openRemoteVscode}
                >
                  <VisualStudioCode aria-hidden="true" className="size-3.5" />
                  <span className="sr-only @3xl/header-actions:not-sr-only @3xl/header-actions:ml-0.5">
                    Open
                  </span>
                </Button>
              }
            />
            <TooltipPopup side="bottom">
              Open VS Code Remote SSH: {remoteVscodeTarget.authority}
            </TooltipPopup>
          </Tooltip>
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            isPreparingWorktree={isPreparingWorktree}
            onOpenPullRequest={onOpenPullRequest}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
