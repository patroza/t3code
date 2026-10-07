// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  appendDiscordAttachmentPromptBlock,
  ATTACHMENT_ONLY_PROMPT,
  downloadDiscordAttachmentsToWorkspace,
  formatDiscordAttachmentPromptBlock,
} from "./discordInboundFiles.ts";

describe("discordInboundFiles", () => {
  const originalFetch = globalThis.fetch;
  let tempDir: string;

  beforeEach(() => {
    tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "discord-files-"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    NodeFS.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("downloads arbitrary Discord attachments into a temp staging directory", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("<html>hello</html>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    ) as typeof fetch;

    const result = await downloadDiscordAttachmentsToWorkspace({
      attachments: [
        {
          filename: "../incident report.html",
          content_type: "text/html; charset=utf-8",
          url: "https://cdn.discordapp.com/report.html",
        },
      ],
      discordThreadId: "thread-123",
      messageId: "message-456",
    });

    expect(result.skipped).toEqual([]);
    expect(result.saved).toHaveLength(1);
    expect(result.saved[0]?.name).toBe("incident report.html");
    expect(result.saved[0]?.absolutePath).toContain(
      `${NodePath.sep}t3-discord-attachments${NodePath.sep}thread-123${NodePath.sep}message-456${NodePath.sep}`,
    );
    expect(NodeFS.readFileSync(result.saved[0]!.absolutePath, "utf8")).toBe("<html>hello</html>");
  });

  it("deduplicates filenames within the same message", async () => {
    globalThis.fetch = vi.fn(async () => new Response("a", { status: 200 })) as typeof fetch;

    const result = await downloadDiscordAttachmentsToWorkspace({
      attachments: [
        { filename: "report.html", url: "https://cdn.discordapp.com/1" },
        { filename: "report.html", url: "https://cdn.discordapp.com/2" },
      ],
      discordThreadId: "thread",
      messageId: "message",
    });

    expect(result.saved.map((attachment) => attachment.name)).toEqual([
      "report.html",
      "report-2.html",
    ]);
  });

  it("falls back to the alternate Discord attachment URL when the first source fails", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      if (url === "https://cdn.discordapp.com/report.html") {
        return new Response("unsupported", { status: 415 });
      }
      if (url === "https://media.discordapp.net/report.html") {
        return new Response("<title>Developer handover</title>", {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      }
      return new Response("missing", { status: 404 });
    }) as typeof fetch;

    const result = await downloadDiscordAttachmentsToWorkspace({
      attachments: [
        {
          filename: "report.html",
          content_type: "text/html; charset=utf-8",
          url: "https://cdn.discordapp.com/report.html",
          proxy_url: "https://media.discordapp.net/report.html",
        },
      ],
      discordThreadId: "thread",
      messageId: "message",
    });

    expect(result.skipped).toEqual([]);
    expect(result.saved).toHaveLength(1);
    expect(NodeFS.readFileSync(result.saved[0]!.absolutePath, "utf8")).toBe(
      "<title>Developer handover</title>",
    );
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("records all attempted Discord attachment sources when every download fails", async () => {
    globalThis.fetch = vi.fn(async (input) => {
      const url = String(input);
      return new Response(url.includes("cdn.discordapp.com") ? "unsupported" : "missing", {
        status: url.includes("cdn.discordapp.com") ? 415 : 404,
      });
    }) as typeof fetch;

    const result = await downloadDiscordAttachmentsToWorkspace({
      attachments: [
        {
          filename: "report.html",
          url: "https://cdn.discordapp.com/report.html",
          proxy_url: "https://media.discordapp.net/report.html",
        },
      ],
      discordThreadId: "thread",
      messageId: "message",
    });

    expect(result.saved).toEqual([]);
    expect(result.skipped).toEqual([
      {
        filename: "report.html",
        reason: "url:http 415; proxy_url:http 404",
      },
    ]);
  });

  it("formats markdown links for prompt injection", () => {
    const prompt = appendDiscordAttachmentPromptBlock({
      prompt: ATTACHMENT_ONLY_PROMPT,
      attachments: [
        {
          name: "report.html",
          absolutePath: "/tmp/t3-discord-attachments/thread/message/report.html",
          mimeType: "text/html",
          sizeBytes: 42,
        },
      ],
    });

    expect(formatDiscordAttachmentPromptBlock([])).toBe("");
    expect(prompt).toContain("## Discord attachments");
    expect(prompt).toContain(
      "[report.html](/tmp/t3-discord-attachments/thread/message/report.html)",
    );
  });
});
