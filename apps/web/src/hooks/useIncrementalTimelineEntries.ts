import { useState } from "react";
import { shallow } from "zustand/vanilla/shallow";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesInput,
  type TimelineEntriesProjection,
} from "../session-logic";

function sameAnchoredMessages(
  left: TimelineEntriesInput["anchoredMessages"],
  right: TimelineEntriesInput["anchoredMessages"],
): boolean {
  return (
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.length === right.length &&
      left.every((message, index) => shallow(message, right[index])))
  );
}

function sameInput(left: TimelineEntriesInput, right: TimelineEntriesInput): boolean {
  return (
    left.visibleTurnItems === right.visibleTurnItems &&
    left.optimisticMessages === right.optimisticMessages &&
    sameAnchoredMessages(left.anchoredMessages, right.anchoredMessages) &&
    shallow(left.attachmentUrlById, right.attachmentUrlById) &&
    left.attempts === right.attempts &&
    left.nodes === right.nodes &&
    left.plans === right.plans
  );
}

export function useIncrementalTimelineEntries(
  threadKey: string | null,
  input: TimelineEntriesInput,
): TimelineEntriesProjection["entries"] {
  const [state, setState] = useState(() => ({
    threadKey,
    projection: deriveTimelineEntriesFromVisibleTurnItemsWithState(input),
  }));
  // Render-phase updates can discard compiler caches before the first commit,
  // so equivalent derived feedback rows and URL maps must not trigger another update.
  if (state.threadKey === threadKey && sameInput(state.projection.input, input)) {
    return state.projection.entries;
  }
  const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    input,
    state.threadKey === threadKey ? state.projection : null,
  );
  setState({ threadKey, projection });
  return projection.entries;
}
