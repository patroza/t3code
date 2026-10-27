import { describe, expect, it } from "vite-plus/test";

import {
  filterDiscordImageAttachments,
  guessMimeFromFilename,
  isDiscordImageAttachment,
} from "./discordInboundImages.ts";

describe("isDiscordImageAttachment", () => {
  it("accepts image content types", () => {
    expect(
      isDiscordImageAttachment({
        filename: "shot.png",
        content_type: "image/png",
        url: "https://cdn.discordapp.com/a.png",
      }),
    ).toBe(true);
  });

  it("rejects svg", () => {
    expect(
      isDiscordImageAttachment({
        filename: "x.svg",
        content_type: "image/svg+xml",
        url: "https://cdn.discordapp.com/x.svg",
      }),
    ).toBe(false);
  });

  it("accepts image extensions without content_type", () => {
    expect(
      isDiscordImageAttachment({
        filename: "ui.jpg",
        url: "https://cdn.discordapp.com/ui.jpg",
      }),
    ).toBe(true);
  });

  it("accepts dimensioned attachments", () => {
    expect(
      isDiscordImageAttachment({
        filename: "paste",
        width: 800,
        height: 600,
        url: "https://cdn.discordapp.com/paste",
      }),
    ).toBe(true);
  });

  it("rejects non-images", () => {
    expect(
      isDiscordImageAttachment({
        filename: "notes.txt",
        content_type: "text/plain",
        url: "https://cdn.discordapp.com/notes.txt",
      }),
    ).toBe(false);
  });
});

describe("filterDiscordImageAttachments", () => {
  it("keeps only images", () => {
    const out = filterDiscordImageAttachments([
      { filename: "a.png", content_type: "image/png", url: "u1" },
      { filename: "b.pdf", content_type: "application/pdf", url: "u2" },
      { filename: "c.webp", url: "u3" },
    ]);
    expect(out.map((a) => a.filename)).toEqual(["a.png", "c.webp"]);
  });
});

describe("guessMimeFromFilename", () => {
  it("maps common extensions", () => {
    expect(guessMimeFromFilename("x.PNG")).toBe("image/png");
    expect(guessMimeFromFilename("x.jpeg")).toBe("image/jpeg");
    expect(guessMimeFromFilename("x")).toBe(null);
  });
});
