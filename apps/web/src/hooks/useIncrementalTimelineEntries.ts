import { useLocale, useMessages } from "gt-react";
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
  timelineInput: TimelineEntriesInput,
): TimelineEntriesProjection["entries"] {
  // Keyed on the locale: without a GTProvider, useMessages() returns a new function every render.
  const locale = useLocale();
  const resolve = useMessages();
  const input = { ...timelineInput, resolve: timelineInput.resolve ?? resolve };
  const [state, setState] = useState(() => ({
    threadKey,
    locale,
    projection: deriveTimelineEntriesFromVisibleTurnItemsWithState(input),
  }));
  const reusable = state.threadKey === threadKey && state.locale === locale;
  if (reusable && sameInput(state.projection.input, input)) {
    return state.projection.entries;
  }
  const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(
    input,
    reusable ? state.projection : null,
  );
  setState({ threadKey, locale, projection });
  return projection.entries;
}
