import { MessageId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { QueuedMessageChips, type DisplayQueuedMessage } from "./QueuedMessageChips";

function makeQueued(overrides: Partial<DisplayQueuedMessage> = {}): DisplayQueuedMessage {
  return {
    messageId: MessageId.make("msg-queued-1"),
    text: "follow up after this turn",
    attachmentCount: 0,
    pending: false,
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
    expect(html).toContain('data-queued-message-pending="false"');
    expect(html).not.toContain('disabled=""');
  });

  it("labels attachment-only queued messages", () => {
    const html = renderToStaticMarkup(
      <QueuedMessageChips
        queuedMessages={[makeQueued({ text: "", attachmentCount: 1 })]}
        onSteer={() => {}}
        onEdit={() => {}}
      />,
    );

    expect(html).toContain("1 attachment(s)");
  });

  it("renders an unacknowledged send as an inert pending chip", () => {
    const html = renderToStaticMarkup(
      <QueuedMessageChips
        queuedMessages={[makeQueued({ text: "queued optimistically", pending: true })]}
        onSteer={() => {}}
        onEdit={() => {}}
      />,
    );

    // The text is visible immediately; Steer/Edit stay inert until the server
    // knows about the message.
    expect(html).toContain("queued optimistically");
    expect(html).toContain('data-queued-message-pending="true"');
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
