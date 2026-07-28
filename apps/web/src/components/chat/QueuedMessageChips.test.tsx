import { MessageId, type OrchestrationQueuedMessage } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { QueuedMessageChips } from "./QueuedMessageChips";

function makeQueued(
  overrides: Partial<OrchestrationQueuedMessage> = {},
): OrchestrationQueuedMessage {
  return {
    messageId: MessageId.make("msg-queued-1"),
    text: "follow up after this turn",
    attachments: [],
    queuedAt: "2026-07-28T12:00:00.000Z",
    ...overrides,
  };
}

describe("QueuedMessageChips", () => {
  it("renders nothing when the queue is empty", () => {
    expect(
      renderToStaticMarkup(
        <QueuedMessageChips queuedMessages={[]} onSteer={() => {}} onEdit={() => {}} />,
      ),
    ).toBe("");
  });

  it("shows queued text plus Steer and Edit affordances", () => {
    const html = renderToStaticMarkup(
      <QueuedMessageChips queuedMessages={[makeQueued()]} onSteer={() => {}} onEdit={() => {}} />,
    );

    expect(html).toContain("follow up after this turn");
    expect(html).toContain('aria-label="Edit queued message"');
    expect(html).toContain("Steer: send now, interrupting the current step");
    expect(html).toContain("Steer");
  });

  it("labels attachment-only queued messages", () => {
    const html = renderToStaticMarkup(
      <QueuedMessageChips
        queuedMessages={[
          makeQueued({
            text: "",
            // Length is what the chip labels; shape is not rendered.
            attachments: [{} as OrchestrationQueuedMessage["attachments"][number]],
          }),
        ]}
        onSteer={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(html).toContain("1 attachment(s)");
  });
});
