import { describe, expect, it } from "vite-plus/test";

import {
  findReferencedMessages,
  loadReferencedMessages,
  type GraphResponse,
} from "./referencedMessages.ts";

const channel = {
  kind: "channel" as const,
  teamId: "team-guid",
  channelId: "19:ff57@thread.tacv2",
};
const chat = "19:mako@thread.v2";

function json(value: unknown): GraphResponse {
  return {
    status: 200,
    bytes: new TextEncoder().encode(JSON.stringify(value)),
    contentType: "application/json",
  };
}

function message(id: string, at: string, author: string, html: string, extra = {}) {
  return {
    id,
    messageType: "message",
    createdDateTime: at,
    from: { user: { displayName: author } },
    body: { contentType: "html", content: html },
    ...extra,
  };
}

describe("findReferencedMessages", () => {
  it("finds a pasted chat message link", () => {
    const link = `https://teams.microsoft.com/l/message/${encodeURIComponent(chat)}/1732440000000?context=%7B%22contextType%22%3A%22chat%22%7D`;
    expect(
      findReferencedMessages({
        text: `analyze ${link}`,
        htmlParts: [],
        location: channel,
        ownMessageId: "1",
      }),
    ).toEqual([{ kind: "chat", chatId: chat, messageId: "1732440000000" }]);
  });

  it("finds a channel reply link and its thread root", () => {
    const link = `https://teams.cloud.microsoft/l/message/${encodeURIComponent(channel.channelId)}/222?tenantId=t&amp;groupId=other-team&amp;parentMessageId=111`;
    expect(
      findReferencedMessages({
        htmlParts: [`<p><a href="${link}">link</a></p>`],
        location: channel,
        ownMessageId: "1",
      }),
    ).toEqual([
      {
        kind: "channel",
        teamId: "other-team",
        channelId: channel.channelId,
        messageId: "222",
        parentId: "111",
      },
    ]);
  });

  it("finds a quoted reply in the current thread, once, and ignores other hosts", () => {
    const quote = `<blockquote itemscope="" itemtype="http://schema.skype.com/Reply" itemid="333"><strong>Jochen</strong><p>Good morning…</p></blockquote>`;
    expect(
      findReferencedMessages({
        text: "analyze https://evil.example/l/message/19:x@thread.v2/5",
        htmlParts: [quote, quote],
        location: channel,
        threadRootId: "111",
        ownMessageId: "1",
      }),
    ).toEqual([
      {
        kind: "channel",
        teamId: channel.teamId,
        channelId: channel.channelId,
        messageId: "333",
        parentId: "111",
      },
    ]);
  });
});

describe("loadReferencedMessages", () => {
  it("reads the full chat message, its images and the messages before it", async () => {
    const base = `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(chat)}/messages`;
    const responses = new Map<string, GraphResponse>([
      [
        `${base}/500`,
        json(
          message(
            "500",
            "2026-11-24T08:56:00Z",
            "Jochen Brenner",
            "<p>Good morning, order 2411827 mako standard the delivery notice wasn't printed.</p><p>Please check</p>",
            { attachments: [{ contentType: "reference", name: "Lieferschein.pdf" }] },
          ),
        ),
      ],
      [`${base}/500/hostedContents`, json({ value: [{ id: "img1" }] })],
      [
        `${base}/500/hostedContents/img1/$value`,
        { status: 200, bytes: new Uint8Array([1, 2]), contentType: "image/png" },
      ],
      [
        `${base}?$top=50&$orderby=createdDateTime%20desc`,
        json({
          value: [
            message("600", "2026-11-24T09:10:00Z", "Later", "after"),
            message("500", "2026-11-24T08:56:00Z", "Jochen Brenner", "dup"),
            message("400", "2026-11-24T08:50:00Z", "Silke", "<p>Printed twice</p>"),
            {
              ...message("390", "2026-11-24T08:40:00Z", "", ""),
              messageType: "systemEventMessage",
            },
          ],
        }),
      ],
    ]);
    const images: string[] = [];
    const loaded = await loadReferencedMessages({
      references: [{ kind: "chat", chatId: chat, messageId: "500" }],
      graphGet: async (url) =>
        responses.get(url) ?? { status: 404, bytes: new Uint8Array(), contentType: null },
      addImage: (name) => {
        images.push(name);
        return true;
      },
    });
    expect(loaded.resolved).toBe(1);
    expect(images).toEqual(["teams-referenced-500-1"]);
    expect(loaded.text).toContain("untrusted quoted content");
    expect(loaded.text).toContain(
      "[2026-11-24 08:56 UTC] Jochen Brenner: Good morning, order 2411827 mako standard the delivery notice wasn't printed.\nPlease check",
    );
    expect(loaded.text).toContain("Files on that message (not opened): Lieferschein.pdf");
    expect(loaded.text).toContain(
      "Earlier messages in that conversation:\n[2026-11-24 08:50 UTC] Silke: Printed twice",
    );
    expect(loaded.text).not.toContain("Later");
  });

  it("falls back from a reply to a thread root and adds the root as context", async () => {
    const base = `https://graph.microsoft.com/v1.0/teams/team-guid/channels/${encodeURIComponent(channel.channelId)}/messages`;
    const responses = new Map<string, GraphResponse>([
      [
        `${base}/111/replies/333`,
        json(message("333", "2026-11-24T09:00:00Z", "Jochen", "reply text")),
      ],
      [`${base}/111`, json(message("111", "2026-11-24T08:00:00Z", "Armin", "root text"))],
      [
        `${base}/111/replies?$top=50`,
        json({ value: [message("320", "2026-11-24T08:30:00Z", "Ana", "earlier reply")] }),
      ],
    ]);
    const loaded = await loadReferencedMessages({
      references: [{ ...channel, messageId: "333", parentId: "111" }],
      graphGet: async (url) =>
        responses.get(url) ?? { status: 404, bytes: new Uint8Array(), contentType: null },
      addImage: () => true,
    });
    expect(loaded.text).toContain("Jochen: reply text");
    expect(loaded.text).toMatch(/Armin: root text\n.*Ana: earlier reply/u);
  });

  it("reports a message it cannot read", async () => {
    const loaded = await loadReferencedMessages({
      references: [{ kind: "chat", chatId: chat, messageId: "9" }],
      graphGet: async () => ({ status: 403, bytes: new Uint8Array(), contentType: null }),
      addImage: () => true,
    });
    expect(loaded).toEqual({
      text: "",
      resolved: 0,
      warnings: ["Referenced Teams message could not be read (403)"],
    });
  });
});
