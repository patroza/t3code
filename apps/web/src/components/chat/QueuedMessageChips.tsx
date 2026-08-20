import { memo } from "react";
import { CornerDownRightIcon, ListEndIcon, PencilIcon } from "lucide-react";
import type { MessageId } from "@t3tools/contracts";

import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

/**
 * A queued follow-up as the composer renders it: either server-held, or an
 * optimistic send that will be queued once the server acknowledges it.
 */
export interface DisplayQueuedMessage {
  readonly messageId: MessageId;
  readonly text: string;
  readonly attachmentCount: number;
  /** Not acknowledged yet — the server cannot steer or edit it. */
  readonly pending: boolean;
}

/**
 * Queued follow-up messages held server-side while a turn runs. Each chip
 * offers Send now (steering into the active turn) and Edit (dequeue to the
 * composer); the
 * queue otherwise auto-drains in order when the turn completes naturally.
 */
export const QueuedMessageChips = memo(function QueuedMessageChips({
  queuedMessages,
  disabled,
  onSteer,
  onEdit,
}: {
  readonly queuedMessages: ReadonlyArray<DisplayQueuedMessage>;
  readonly disabled?: boolean;
  readonly onSteer: (messageId: MessageId) => void;
  readonly onEdit: (messageId: MessageId) => void;
}) {
  if (queuedMessages.length === 0) {
    return null;
  }

  return (
    <div className="mx-auto mb-2 flex max-w-3xl flex-col gap-1.5">
      {queuedMessages.map((queuedMessage) => (
        <div
          key={queuedMessage.messageId}
          className={cn(
            "flex items-center gap-2.5 rounded-xl border border-border/60 bg-card/95 py-1.5 pr-1.5 pl-3.5 shadow-sm backdrop-blur",
            queuedMessage.pending && "opacity-60",
          )}
          data-queued-message-pending={queuedMessage.pending ? "true" : "false"}
        >
          <ListEndIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
          <span
            className="min-w-0 flex-1 truncate text-sm text-foreground/90"
            aria-label={queuedMessage.text}
          >
            {queuedMessage.text.length > 0
              ? queuedMessage.text
              : `${queuedMessage.attachmentCount} attachment(s)`}
          </span>
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled || queuedMessage.pending}
            aria-label="Send queued message now"
            title="Send now, interrupting the current step"
            onClick={() => onSteer(queuedMessage.messageId)}
          >
            <CornerDownRightIcon className="size-3.5" />
            Send now
          </Button>
          <Button
            size="icon-xs"
            variant="ghost"
            disabled={disabled || queuedMessage.pending}
            aria-label="Edit queued message"
            title="Remove from queue and edit in composer"
            onClick={() => onEdit(queuedMessage.messageId)}
          >
            <PencilIcon className="size-3.5" />
          </Button>
        </div>
      ))}
    </div>
  );
});
