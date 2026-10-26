export const CHAT_LIST_ANCHOR_OFFSET = 16;

/** Mirror server queue-by-default for follow-ups while a turn starts/runs or awaits its provider session.
 * Bootstrap sends are exempt because they create the thread in the same dispatch.
 * Queued sends appear by the composer, not the chat list, so clients keep the reader's position.
 */
export function sendEntersSteeringQueue(input: {
  readonly hasBootstrap: boolean;
  readonly sessionStatus: string | null | undefined;
  readonly hasPendingTurnStart: boolean;
}): boolean {
  if (input.hasBootstrap) {
    return false;
  }
  return (
    input.sessionStatus === "running" ||
    input.sessionStatus === "starting" ||
    input.hasPendingTurnStart
  );
}

export interface ChatListAnchoredEndSpace {
  readonly anchorIndex: number;
  readonly anchorOffset: number;
}

export interface ChatListAnchorOptions {
  readonly anchorOffset?: number;
}

export function resolveChatListAnchoredEndSpace<Item, AnchorId>(
  items: ReadonlyArray<Item>,
  anchorId: AnchorId | null,
  getAnchorId: (item: Item) => AnchorId | null,
  options: ChatListAnchorOptions = {},
): ChatListAnchoredEndSpace | undefined {
  if (anchorId === null) {
    return undefined;
  }

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (item === undefined) {
      continue;
    }

    const itemAnchorId = getAnchorId(item);
    if (itemAnchorId === null) {
      continue;
    }

    return itemAnchorId === anchorId
      ? {
          anchorIndex: index,
          anchorOffset: options.anchorOffset ?? CHAT_LIST_ANCHOR_OFFSET,
        }
      : undefined;
  }

  return undefined;
}
