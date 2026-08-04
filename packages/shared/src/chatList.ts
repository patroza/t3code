export const CHAT_LIST_ANCHOR_OFFSET = 16;

/**
 * Mirrors the server decider's queue-by-default rule (see
 * `thread.turn.start` in `apps/server/src/orchestration/decider.ts`): a
 * follow-up sent while a turn is starting/running — or while a turn start has
 * been dispatched but the provider has not reported its session yet — is held
 * in the steering queue instead of opening a turn. Bootstrap sends create their
 * thread in the same dispatch and are exempt.
 *
 * Such a send never reaches the chat list; it lands as a queued chip by the
 * composer. Both clients use this to keep the reader's position instead of
 * jumping to the live edge and anchoring a row that will never appear.
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

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && getAnchorId(item) === anchorId) {
      return {
        anchorIndex: index,
        anchorOffset: options.anchorOffset ?? CHAT_LIST_ANCHOR_OFFSET,
      };
    }
  }

  return undefined;
}
