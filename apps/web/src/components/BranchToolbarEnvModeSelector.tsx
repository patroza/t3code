import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type WorkspaceTarget,
} from "./BranchToolbar.logic";
import { useComposerMenuProps } from "./chat/composerEventScope";
import { PreviousWorktreeItemContent } from "./PreviousWorktreeItemContent";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  forceNewWorktree?: boolean;
  envLocked: boolean;
  workspaceTarget: WorkspaceTarget;
  activeWorktreePath: string | null;
  onWorkspaceTargetChange: (target: WorkspaceTarget) => void;
  previousWorktreeLabel?: string | null;
  previousWorktreeBranch?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  forceNewWorktree = false,
  envLocked,
  workspaceTarget,
  activeWorktreePath,
  onWorkspaceTargetChange,
  previousWorktreeLabel,
  previousWorktreeBranch = null,
  onUsePreviousWorktree,
}: BranchToolbarEnvModeSelectorProps) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const showPreviousWorktree = Boolean(previousWorktreeLabel && onUsePreviousWorktree);
  const envModeItems = useMemo(() => {
    const items: Array<{ value: string; label: string }> = [
      { value: "local", label: resolveEnvModeLabel("local") },
    ];
    if (activeWorktreePath) {
      items.push({
        value: "current-worktree",
        label: resolveCurrentWorkspaceLabel(activeWorktreePath),
      });
    }
    items.push({ value: "worktree", label: resolveEnvModeLabel("worktree") });
    if (showPreviousWorktree && previousWorktreeLabel) {
      items.push({ value: PREVIOUS_WORKTREE_SELECT_VALUE, label: previousWorktreeLabel });
    }
    return items;
  }, [activeWorktreePath, previousWorktreeLabel, showPreviousWorktree]);

  if (envLocked || forceNewWorktree) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span />}
          className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-1.75 font-normal text-muted-foreground/70 text-xs sm:h-6"
          data-composer-context-control
        >
          {activeWorktreePath ? (
            <FolderGitIcon className="size-3 shrink-0" />
          ) : effectiveEnvMode === "worktree" ? (
            <FolderGit2Icon className="size-3 shrink-0" />
          ) : (
            <FolderIcon className="size-3 shrink-0" />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              {resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {forceNewWorktree
            ? "Each model starts in its own worktree."
            : resolveLockedWorkspaceLabel(activeWorktreePath, effectiveEnvMode)}
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Select
      modal={false}
      value={workspaceTarget}
      onValueChange={(value: string | null) => {
        if (value === PREVIOUS_WORKTREE_SELECT_VALUE) {
          onUsePreviousWorktree?.();
          return;
        }
        onWorkspaceTargetChange(value as WorkspaceTarget);
      }}
      items={envModeItems}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SelectTrigger
              variant="ghost"
              size="xs"
              className="min-w-0 shrink"
              aria-label="Workspace"
              data-composer-shortcut="composer.workspace"
              data-composer-context-control
            />
          }
        >
          {workspaceTarget === "worktree" ? (
            <FolderGit2Icon className="size-3" />
          ) : workspaceTarget === "current-worktree" ? (
            <FolderGitIcon className="size-3" />
          ) : (
            <FolderIcon className="size-3" />
          )}
          <span
            data-composer-label
            className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
          >
            <span
              data-composer-label-motion
              className="block w-full min-w-0 max-w-[240px] truncate transition-opacity duration-180 ease-drawer group-data-[compact]/composer-context:opacity-0 motion-reduce:transition-none"
            >
              <SelectValue />
            </span>
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          {workspaceTarget === "worktree"
            ? resolveEnvModeLabel("worktree")
            : workspaceTarget === "current-worktree"
              ? resolveCurrentWorkspaceLabel(activeWorktreePath)
              : resolveEnvModeLabel("local")}
        </TooltipPopup>
      </Tooltip>
      <SelectPopup
        alignItemWithTrigger={false}
        className={showPreviousWorktree ? "w-[min(21rem,calc(100vw-2rem))]" : undefined}
        {...composerFloatingLayerProps}
      >
        <SelectGroup>
          <SelectGroupLabel>Workspace</SelectGroupLabel>
          <SelectItem value="local">
            <span className="inline-flex items-center gap-1.5">
              <FolderIcon className="size-3" />
              {resolveEnvModeLabel("local")}
            </span>
          </SelectItem>
          {activeWorktreePath ? (
            <SelectItem value="current-worktree">
              <span className="inline-flex items-center gap-1.5">
                <FolderGitIcon className="size-3" />
                {resolveCurrentWorkspaceLabel(activeWorktreePath)}
              </span>
            </SelectItem>
          ) : null}
          <SelectItem value="worktree">
            <span className="inline-flex items-center gap-1.5">
              <FolderGit2Icon className="size-3" />
              {resolveEnvModeLabel("worktree")}
            </span>
          </SelectItem>
          {showPreviousWorktree && previousWorktreeLabel ? (
            <SelectItem value={PREVIOUS_WORKTREE_SELECT_VALUE}>
              <PreviousWorktreeItemContent branch={previousWorktreeBranch} />
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
