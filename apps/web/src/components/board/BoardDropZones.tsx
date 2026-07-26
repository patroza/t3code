import { useDroppable } from "@dnd-kit/core";
import { ArchiveIcon, ArchiveRestoreIcon, Trash2Icon, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import {
  BOARD_ARCHIVE_DROPPABLE_ID,
  BOARD_TRASH_DROPPABLE_ID,
  BOARD_UNSETTLE_DROPPABLE_ID,
} from "./Board.logic";

function BoardDropZone({
  droppableId,
  testId,
  label,
  icon: Icon,
  activeClass,
}: {
  droppableId: string;
  testId: string;
  label: string;
  icon: LucideIcon;
  activeClass: string;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: droppableId });

  return (
    <div
      ref={setNodeRef}
      data-testid={testId}
      aria-label={label}
      className={cn(
        "flex items-center gap-2 rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur transition-colors sm:px-5",
        isOver ? activeClass : "border-border bg-background/90 text-muted-foreground",
      )}
    >
      <Icon className="size-4" />
      <span className="hidden sm:inline">{label}</span>
    </div>
  );
}

/**
 * Floating droppables shown while a drag is active: archive and delete are
 * always available, and restore (un-settle) appears when the drag includes a
 * settled thread. Columns are derived state, so settling happens by dropping
 * on the Settled column itself rather than a zone here.
 */
export function BoardDropZones({ showRestoreZone }: { showRestoreZone: boolean }) {
  return (
    // w-max: shrink-to-fit against left:50% would otherwise cap the width at
    // half the board and wrap the labels on narrow viewports.
    <div className="absolute bottom-6 left-1/2 z-20 flex w-max -translate-x-1/2 items-center gap-2 sm:gap-3">
      {showRestoreZone ? (
        <BoardDropZone
          droppableId={BOARD_UNSETTLE_DROPPABLE_ID}
          testId="board-restore-zone"
          label="Drop to restore"
          icon={ArchiveRestoreIcon}
          activeClass="border-emerald-500 bg-emerald-500/15 text-emerald-600 dark:text-emerald-300/90"
        />
      ) : null}
      <BoardDropZone
        droppableId={BOARD_ARCHIVE_DROPPABLE_ID}
        testId="board-archive-zone"
        label="Drop to archive"
        icon={ArchiveIcon}
        activeClass="border-amber-500 bg-amber-500/15 text-amber-600 dark:text-amber-300/90"
      />
      <BoardDropZone
        droppableId={BOARD_TRASH_DROPPABLE_ID}
        testId="board-trash-zone"
        label="Drop to delete"
        icon={Trash2Icon}
        activeClass="border-destructive bg-destructive/15 text-destructive"
      />
    </div>
  );
}
