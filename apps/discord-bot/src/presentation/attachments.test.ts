import { describe, expect, it } from "vite-plus/test";

import {
  attachmentKey,
  buildFinalResponseMarkdownText,
  buildStreamHistoryMarkdownText,
  FINAL_RESPONSE_MARKDOWN_NAME,
  finalResponseCaption,
  imageAttachmentsOf,
  shouldAttachFinalResponseAsMarkdown,
  STREAM_HISTORY_MARKDOWN_NAME,
  streamHistoryHasAdditionalContent,
  unpostedAttachments,
  withOmegentMessageLink,
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

describe("final response markdown attachment", () => {
  it("builds response.md body and caption", () => {
    const body = buildFinalResponseMarkdownText("# Summary\n\nLong answer body.");
    expect(body).toContain("# Summary");
    expect(body?.endsWith("\n")).toBe(true);
    expect(FINAL_RESPONSE_MARKDOWN_NAME).toBe("response.md");
    expect(finalResponseCaption("# Summary\n\nLong answer body.")).toBe("Summary");
    expect(finalResponseCaption("x".repeat(200))).toBe(
      `Full response attached as \`${FINAL_RESPONSE_MARKDOWN_NAME}\`.`,
    );
  });

  it("attaches when the answer has tables or would need multiple messages", () => {
    expect(
      shouldAttachFinalResponseAsMarkdown({
        text: "short",
        hasMarkdownTables: false,
        messageChunkCount: 1,
      }),
    ).toBe(false);
    expect(
      shouldAttachFinalResponseAsMarkdown({
        text: "long multi chunk body",
        hasMarkdownTables: false,
        messageChunkCount: 2,
      }),
    ).toBe(true);
    expect(
      shouldAttachFinalResponseAsMarkdown({
        text: "| A | B |\n|---|---|\n| 1 | 2 |",
        hasMarkdownTables: true,
        messageChunkCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldAttachFinalResponseAsMarkdown({
        text: "   ",
        hasMarkdownTables: true,
        messageChunkCount: 3,
      }),
    ).toBe(false);
  });

  it("appends a short T3 deep link on the response.md caption", () => {
    expect(withOmegentMessageLink("Summary", "https://t3vm/?thread=tid-1#message-msg-1")).toBe(
      "Summary · [T3](https://t3vm/?thread=tid-1#message-msg-1)",
    );
    expect(withOmegentMessageLink("Summary", null)).toBe("Summary");
    expect(withOmegentMessageLink("Summary", "  ")).toBe("Summary");
  });
});
