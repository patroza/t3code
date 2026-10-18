import { MessageId } from "@t3tools/contracts";
import {
  codexFeedbackMessage,
  type CodexFeedbackSubmission,
} from "@t3tools/client-runtime/state/threads";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { TimelineEntriesInput } from "../session-logic";
import { makeStreamingTimelineFixture } from "../test-fixtures";
import { useIncrementalTimelineEntries } from "./useIncrementalTimelineEntries";

const emptyItems: TimelineEntriesInput["visibleTurnItems"] = [];
const optimisticMessages: TimelineEntriesInput["optimisticMessages"] = [];
const attachment = {
  type: "image" as const,
  id: "image",
  name: "image.png",
  mimeType: "image/png",
  sizeBytes: 42,
};
const fixture = makeStreamingTimelineFixture("Answer");
const visibleTurnItems = fixture.visibleTurnItems.map((row) =>
  row.item.type === "assistant_message"
    ? { ...row, item: { ...row.item, attachments: [attachment] } }
    : row,
);
const feedbackBase = {
  id: MessageId.make("feedback"),
  command: "/feedback test",
  createdAt: "2026-10-18T00:00:00.000Z",
};
let root: Root;
let container: HTMLDivElement;
let projections: Array<ReturnType<typeof useIncrementalTimelineEntries>>;
function Probe({
  tick,
  feedback,
  imageUrl,
}: {
  tick: number;
  feedback: CodexFeedbackSubmission | null;
  imageUrl?: string;
}) {
  // Exercise a render-phase update before the component's first commit, when
  // React may discard the compiler's cached derived arrays and maps.
  const [initialized, setInitialized] = useState(false);
  if (!initialized) setInitialized(true);
  const entries = useIncrementalTimelineEntries("thread", {
    visibleTurnItems: imageUrl ? visibleTurnItems : emptyItems,
    optimisticMessages,
    anchoredMessages: feedback
      ? [
          { ...codexFeedbackMessage(feedback), runId: null },
          { ...codexFeedbackMessage(feedback, "assistant"), runId: null },
        ]
      : [],
    attachmentUrlById: new Map(imageUrl ? [[attachment.id, imageUrl]] : []),
  });
  projections.push(entries);
  const messages = entries.flatMap((entry) => (entry.kind === "message" ? [entry.message] : []));
  const images = messages.flatMap(
    (message) =>
      message.attachments?.flatMap((item) =>
        item.type === "image" && "previewUrl" in item ? [item.previewUrl] : [],
      ) ?? [],
  );
  return (
    <div data-tick={tick}>
      <pre>{messages.map((message) => message.text).join("\n")}</pre>
      <output>{images.join("\n")}</output>
    </div>
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  projections = [];
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
it("settles initial render updates with recreated empty derived inputs", async () => {
  await act(() => root.render(<Probe tick={0} feedback={null} />));
  const initial = projections.at(-1);
  await act(() => root.render(<Probe tick={1} feedback={null} />));
  expect(projections.at(-1)).toBe(initial);
  expect(container.querySelector("div")?.dataset.tick).toBe("1");
});
it("keeps recreated feedback stable while preserving status and attachment URL updates", async () => {
  await act(() =>
    root.render(
      <Probe
        tick={0}
        feedback={{ ...feedbackBase, status: "uploading" }}
        imageUrl="https://server.test/first"
      />,
    ),
  );
  const initial = projections.at(-1);
  await act(() =>
    root.render(
      <Probe
        tick={1}
        feedback={{ ...feedbackBase, status: "uploading" }}
        imageUrl="https://server.test/first"
      />,
    ),
  );
  expect(projections.at(-1)).toBe(initial);
  expect(container.textContent).toContain("Sending feedback to OpenAI...");
  await act(() =>
    root.render(
      <Probe
        tick={2}
        feedback={{ ...feedbackBase, status: "sent", feedbackId: "sent-feedback" }}
        imageUrl="https://server.test/second"
      />,
    ),
  );
  expect(projections.at(-1)).not.toBe(initial);
  expect(container.textContent).toContain("Feedback sent to OpenAI.");
  expect(container.querySelector("output")?.textContent).toContain("https://server.test/second");
  expect(container.querySelector("output")?.textContent).not.toContain("https://server.test/first");
});
