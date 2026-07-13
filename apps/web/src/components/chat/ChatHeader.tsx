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
import { memo, useCallback, useMemo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AiUsageStats } from "./AiUsageStats";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { useEnvironment, usePrimaryEnvironmentId } from "../../state/environments";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { VisualStudioCode } from "../Icons";
import { readLocalApi } from "~/localApi";
import { useAiUsageSnapshot } from "../../hooks/useAiUsageSnapshot";
import { resolveDriverUsage, usageDotFillClass, usageDotRingColor } from "../../aiUsageState";
import { HostResourceStatus } from "../HostResourceStatus";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  isPreparingWorktree: boolean;
  /** For showing usage dot on the active thread's model at conversation level. */
  activeThreadDriverKind?: ProviderDriverKind | null;
  activeThreadModel?: string | null;
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
  let username: string | null = "patroza";

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
    try {
      hostname = new URL(entry.profile.value.httpBaseUrl).hostname;
    } catch {
      hostname = null;
    }
  }

  if (!hostname) return null;
  const authority = username ? `${username}@${hostname}` : hostname;
  const uri = `vscode://vscode-remote/ssh-remote+${encodeURIComponent(authority)}${encodeRemotePath(
    input.cwd,
  )}`;
  return { authority, uri };
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  isPreparingWorktree,
  activeThreadDriverKind,
  activeThreadModel,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activeEnvironment = useEnvironment(activeThreadEnvironmentId);
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const remoteVscodeTarget = useMemo(
    () =>
      activeProjectName && !showOpenInPicker
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

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
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
          showHostname
          className="hidden @2xl/header-actions:flex"
        />
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
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
