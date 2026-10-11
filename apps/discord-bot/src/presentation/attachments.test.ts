import { describe, expect, it } from "vite-plus/test";

import {
  appendT3DeepLinkToChunks,
  attachmentKey,
  buildStreamHistoryMarkdownText,
  channelTopicOptsIntoInProgressStream,
  imageAttachmentsOf,
  IN_PROGRESS_STREAM_TOPIC_TAG,
  shouldAttachStreamHistory,
  STREAM_HISTORY_MARKDOWN_NAME,
  streamHistoryHasAdditionalContent,
  unpostedAttachments,
  withT3DeepLink,
} from "./attachments.ts";

describe("imageAttachmentsOf", () => {
  it("filters to image attachments", () => {
    const images = imageAttachmentsOf([
      {
        type: "image",
        id: "a1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 12,
      },
    ]);
    expect(images).toHaveLength(1);
    expect(images[0]?.id).toBe("a1");
  });

  it("returns empty for missing attachments", () => {
    expect(imageAttachmentsOf(undefined)).toEqual([]);
    expect(imageAttachmentsOf(null)).toEqual([]);
    expect(imageAttachmentsOf([])).toEqual([]);
  });
});

describe("unpostedAttachments", () => {
  it("skips already posted ids", () => {
    const all = [
      {
        type: "image" as const,
        id: "a1",
        name: "a.png",
        mimeType: "image/png",
        sizeBytes: 1,
      },
      {
        type: "image" as const,
        id: "a2",
        name: "b.png",
        mimeType: "image/png",
        sizeBytes: 1,
      },
    ];
    expect(unpostedAttachments(all, ["a1"]).map((e) => e.id)).toEqual(["a2"]);
    expect(attachmentKey(all)).toBe("a1,a2");
  });
});

describe("streamHistoryHasAdditionalContent", () => {
  it("is false when history equals the final message (no intermediate tips)", () => {
    const body = "👍 Sounds good. Ping this thread anytime.";
    expect(streamHistoryHasAdditionalContent(body, body)).toBe(false);
    expect(streamHistoryHasAdditionalContent(`  ${body}\n`, body)).toBe(false);
  });

  it("is false for empty or placeholder stream bodies", () => {
    expect(streamHistoryHasAdditionalContent("", "final answer")).toBe(false);
    expect(streamHistoryHasAdditionalContent("   \n", "final answer")).toBe(false);
    expect(streamHistoryHasAdditionalContent("…", "final answer")).toBe(false);
  });

  it("is true when history has intermediate progress beyond the final answer", () => {
    expect(
      streamHistoryHasAdditionalContent(
        "Checking PR…\n\n👍 Sounds good. Ping this thread anytime.",
        "👍 Sounds good. Ping this thread anytime.",
      ),
    ).toBe(true);
  });
});

describe("channelTopicOptsIntoInProgressStream", () => {
  it("is opt-in via the omegent-ips topic tag", () => {
    expect(IN_PROGRESS_STREAM_TOPIC_TAG).toBe("omegent-ips");
    expect(channelTopicOptsIntoInProgressStream("t3-example omegent-ips")).toBe(true);
    expect(channelTopicOptsIntoInProgressStream("Notes OMEGENT-IPS here")).toBe(true);
    expect(channelTopicOptsIntoInProgressStream("t3-ips")).toBe(true);
    expect(channelTopicOptsIntoInProgressStream("legacy T3-IPS")).toBe(true);
    expect(channelTopicOptsIntoInProgressStream("t3-example")).toBe(false);
    expect(channelTopicOptsIntoInProgressStream("omegent-ipsum")).toBe(false);
    expect(channelTopicOptsIntoInProgressStream("t3-ipsum")).toBe(false);
    expect(channelTopicOptsIntoInProgressStream(null)).toBe(false);
    expect(channelTopicOptsIntoInProgressStream(undefined)).toBe(false);
    expect(channelTopicOptsIntoInProgressStream("")).toBe(false);
  });
});

describe("shouldAttachStreamHistory", () => {
  const history = "Checking PR…\n\nDone.";
  const finalText = "Done.";

  it("attaches only when the channel opted in and the stream has extra progress", () => {
    expect(
      shouldAttachStreamHistory({
        channelTopicOptIn: true,
        alreadyPosted: false,
        hadStreamMessages: true,
        historyText: history,
        finalText,
      }),
    ).toBe(true);
  });

  it("stays off without the topic opt-in, even when the stream has extra progress", () => {
    expect(
      shouldAttachStreamHistory({
        channelTopicOptIn: false,
        alreadyPosted: false,
        hadStreamMessages: true,
        historyText: history,
        finalText,
      }),
    ).toBe(false);
  });

  it("stays off when already posted, when there were no stream tips, or when history is the final answer", () => {
    expect(
      shouldAttachStreamHistory({
        channelTopicOptIn: true,
        alreadyPosted: true,
        hadStreamMessages: true,
        historyText: history,
        finalText,
      }),
    ).toBe(false);
    expect(
      shouldAttachStreamHistory({
        channelTopicOptIn: true,
        alreadyPosted: false,
        hadStreamMessages: false,
        historyText: history,
        finalText,
      }),
    ).toBe(false);
    expect(
      shouldAttachStreamHistory({
        channelTopicOptIn: true,
        alreadyPosted: false,
        hadStreamMessages: true,
        historyText: finalText,
        finalText,
      }),
    ).toBe(false);
  });
});

describe("buildStreamHistoryMarkdownText", () => {
  it("archives non-empty stream text", () => {
    const text = buildStreamHistoryMarkdownText("Working…\npartial answer");
    expect(text).not.toBeNull();
    expect(text).toContain("In-progress stream");
    expect(text).toContain("partial answer");
    expect(STREAM_HISTORY_MARKDOWN_NAME).toBe("stream-history.md");
  });

  it("returns null for blank stream text", () => {
    expect(buildStreamHistoryMarkdownText("   \n")).toBeNull();
  });
});

describe("T3 deep link caption helpers", () => {
  it("appends a short same-line T3 link on the stats footer", () => {
    expect(
      withT3DeepLink(
        "_`grok-4.5` · effort high · 50s_",
        "https://t3vm.tail86038f.ts.net/?thread=tid-1#message-msg-1",
      ),
    ).toBe(
      "_`grok-4.5` · effort high · 50s_ · [T3](https://t3vm.tail86038f.ts.net/?thread=tid-1#message-msg-1)",
    );
    expect(withT3DeepLink("Summary", null)).toBe("Summary");
  });

  it("appends the link onto the last chunk without overflowing", () => {
    const url = "https://t3vm.example/?thread=t#message-m";
    expect(appendT3DeepLinkToChunks(["hello"], url, 2000)).toEqual([`hello · [T3](${url})`]);
    const almostFull = "x".repeat(1990);
    const next = appendT3DeepLinkToChunks([almostFull], url, 2000);
    expect(next).toHaveLength(2);
    expect(next[1]).toBe(`[T3](${url})`);
  });
});
