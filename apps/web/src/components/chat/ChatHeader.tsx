import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ConnectionCatalogEntry } from "@t3tools/client-runtime/connection";
import * as Option from "effect/Option";
import { memo, useCallback, useMemo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { ProjectFavicon } from "../ProjectFavicon";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { VisualStudioCode } from "../Icons";
import { readLocalApi } from "~/localApi";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  onNewThreadInProject: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
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
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
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
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <span className="inline-flex shrink-0 items-center gap-2">
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
                  className="size-3.5"
                />
                <span className="max-w-40 truncate text-sm font-medium">{activeProjectName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
            </Tooltip>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      </div>
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
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
