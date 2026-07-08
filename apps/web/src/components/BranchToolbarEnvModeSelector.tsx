import { FolderGit2Icon, FolderGitIcon, FolderIcon } from "lucide-react";
import { memo, useMemo } from "react";

import {
  resolveCurrentWorkspaceLabel,
  resolveEnvModeLabel,
  resolveLockedWorkspaceLabel,
  type WorkspaceTarget,
} from "./BranchToolbar.logic";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

interface BranchToolbarEnvModeSelectorProps {
  envLocked: boolean;
  workspaceTarget: WorkspaceTarget;
  activeWorktreePath: string | null;
  onWorkspaceTargetChange: (target: WorkspaceTarget) => void;
}

export const BranchToolbarEnvModeSelector = memo(function BranchToolbarEnvModeSelector({
  envLocked,
  workspaceTarget,
  activeWorktreePath,
  onWorkspaceTargetChange,
}: BranchToolbarEnvModeSelectorProps) {
  const envModeItems = useMemo(() => {
    const items: Array<{ value: WorkspaceTarget; label: string }> = [
      { value: "local", label: resolveEnvModeLabel("local") },
    ];
    if (activeWorktreePath) {
      items.push({
        value: "current-worktree",
        label: resolveCurrentWorkspaceLabel(activeWorktreePath),
      });
    }
    items.push({ value: "worktree", label: resolveEnvModeLabel("worktree") });
    return items;
  }, [activeWorktreePath]);

  if (envLocked) {
    return (
      <span className="inline-flex items-center gap-1 border border-transparent px-[calc(--spacing(3)-1px)] text-sm font-medium text-muted-foreground/70 sm:text-xs">
        {activeWorktreePath ? (
          <>
            <FolderGitIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        ) : (
          <>
            <FolderIcon className="size-3" />
            {resolveLockedWorkspaceLabel(activeWorktreePath)}
          </>
        )}
      </span>
    );
  }

  return (
    <Select
      modal={false}
      value={workspaceTarget}
      onValueChange={(value) => onWorkspaceTargetChange(value as WorkspaceTarget)}
      items={envModeItems}
    >
      <SelectTrigger variant="ghost" size="xs" className="font-medium" aria-label="Workspace">
        {workspaceTarget === "worktree" ? (
          <FolderGit2Icon className="size-3" />
        ) : workspaceTarget === "current-worktree" ? (
          <FolderGitIcon className="size-3" />
        ) : (
          <FolderIcon className="size-3" />
        )}
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
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
        </SelectGroup>
      </SelectPopup>
    </Select>
  );
});
