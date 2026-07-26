import { useDroppable } from "@dnd-kit/core";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { ScrollArea } from "../ui/scroll-area";
import { BOARD_COLUMN_LABELS, type BoardColumnId } from "./Board.logic";

/** Small rounded count pill used by column headers and worktree groups. */
export function BoardCountPill({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-muted px-1 text-xs tabular-nums text-muted-foreground",
        className,
      )}
    >
      {count}
    </span>
  );
}

export function BoardColumn({
  columnId,
  count,
  children,
}: {
  columnId: BoardColumnId;
  count: number;
  children: ReactNode;
}) {
  // Only the settled column accepts drops (dropping a card there settles the
  // thread); the droppable ids are per-column so the intent resolver only
  // matches the settled one.
  const { isOver, setNodeRef } = useDroppable({
    id: `board-column-${columnId}`,
    disabled: columnId !== "settled",
  });

  return (
    <section
      ref={setNodeRef}
      data-testid={`board-column-${columnId}`}
      className={cn(
        "flex h-full w-72 shrink-0 flex-col rounded-xl border border-border/55 bg-muted/30",
        columnId === "settled" && isOver && "border-primary/60 bg-primary/5",
      )}
      aria-label={BOARD_COLUMN_LABELS[columnId]}
    >
      <header className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
        <span className="text-xs font-medium text-foreground">{BOARD_COLUMN_LABELS[columnId]}</span>
        <BoardCountPill count={count} />
      </header>
      {/* Horizontal touch pans must chain to the board's scroll container;
          the viewport's default overscroll containment would swallow them. */}
      <ScrollArea className="min-h-0 flex-1" chainHorizontalScroll>
        <div className="flex flex-col gap-2 p-2 pt-0.5">
          {count === 0 ? (
            <div className="rounded-lg border border-dashed border-border/55 px-3 py-6 text-center text-xs text-muted-foreground/50">
              No threads
            </div>
          ) : (
            children
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
