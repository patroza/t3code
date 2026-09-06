import { FolderGit2Icon, FolderGitIcon, FolderIcon, HistoryIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type WorkspaceTarget,
} from "./BranchToolbar.logic";
import { composerFloatingLayerProps } from "./chat/composerEventScope";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

const PREVIOUS_WORKTREE_SELECT_VALUE = "previous-worktree";

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  workspaceTarget: WorkspaceTarget;
  activeWorktreePath: string | null;
  onWorkspaceTargetChange: (target: WorkspaceTarget) => void;
  previousWorktreeLabel?: string | null;
  onUsePreviousWorktree?: () => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  workspaceTarget,
  activeWorktreePath,
  onWorkspaceTargetChange,
  previousWorktreeLabel,
  onUsePreviousWorktree,
}: BranchToolbarEnvModeSelectorProps) {
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

  if (envLocked) {
    return (
      <span
        className="inline-flex h-7 min-w-0 items-center gap-1 border border-transparent px-[calc(--spacing(2)-1px)] font-normal text-muted-foreground/70 text-xs sm:h-6"
        data-composer-context-control
      >
        {activeWorktreePath ? (
          <FolderGitIcon className="size-3 shrink-0" />
        ) : (
          <FolderIcon className="size-3 shrink-0" />
        )}
        <span
          data-composer-label
          className="min-w-0 max-w-[240px] group-data-[compact]/composer-context:max-w-0"
        >
          <span
            data-composer-label-motion
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </span>
        </span>
      </span>
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
      <SelectTrigger
        variant="ghost"
        size="xs"
        className="min-w-0 shrink font-normal text-xs!"
        aria-label="Workspace"
        data-composer-context-control
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
            className="block w-full min-w-0 max-w-[240px] origin-left truncate transition-[opacity,transform] duration-180 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-[compact]/composer-context:[transform:translateX(-0.25rem)_scaleX(0.95)] group-data-[compact]/composer-context:opacity-0 motion-reduce:transform-none motion-reduce:transition-opacity"
          >
            <SelectValue />
          </span>
        </span>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false} {...composerFloatingLayerProps}>
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
              <span className="inline-flex items-center gap-1.5">
                <HistoryIcon className="size-3" />
                {previousWorktreeLabel}
              </span>
            </SelectItem>
          ) : null}
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
