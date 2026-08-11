// @effect-diagnostics globalDate:off
import { describe, expect, it } from "vite-plus/test";

import {
  AZURE_BLOB_LINK_TTL_MS,
  buildOpaqueBlobName,
  DISCORD_CONSERVATIVE_UPLOAD_LIMIT_BYTES,
  formatOversizedAttachmentNote,
  isAzureBlobUploadConfigured,
  sanitizeBlobFileName,
  type UploadedAzureBlobLink,
} from "./azureBlobUpload.ts";

describe("isAzureBlobUploadConfigured", () => {
  it("is false when nothing is set", () => {
    expect(
      isAzureBlobUploadConfigured({
        connectionString: undefined,
        accountName: undefined,
        accountKey: undefined,
        containerName: "discord-bot-attachments",
      }),
    ).toBe(false);
    expect(isAzureBlobUploadConfigured(undefined)).toBe(false);
  });

  it("accepts a connection string", () => {
    expect(
      isAzureBlobUploadConfigured({
        connectionString: "AccountName=demo;AccountKey=abc==;EndpointSuffix=core.windows.net",
        accountName: undefined,
        accountKey: undefined,
        containerName: "discord-bot-attachments",
      }),
    ).toBe(true);
  });

  it("accepts account name + key", () => {
    expect(
      isAzureBlobUploadConfigured({
        connectionString: undefined,
        accountName: "demo",
        accountKey: "abc==",
        containerName: "discord-bot-attachments",
      }),
    ).toBe(true);
  });

  it("rejects partial account credentials", () => {
    expect(
      isAzureBlobUploadConfigured({
        connectionString: undefined,
        accountName: "demo",
        accountKey: undefined,
        containerName: "discord-bot-attachments",
      }),
    ).toBe(false);
  });
});

describe("sanitizeBlobFileName", () => {
  it("keeps a safe stem and extension", () => {
    expect(sanitizeBlobFileName("report.csv")).toEqual({ stem: "report", extension: ".csv" });
  });

  it("strips unsafe characters", () => {
    expect(sanitizeBlobFileName("../../evil name?.tar.gz")).toEqual({
      stem: "evil-name-.tar",
      extension: ".gz",
    });
  });

  it("falls back for empty names", () => {
    expect(sanitizeBlobFileName("   ")).toEqual({ stem: "attachment", extension: ".bin" });
  });
});

describe("buildOpaqueBlobName", () => {
  it("includes date, uuid directory, and random filename postfix", () => {
    const name = buildOpaqueBlobName("Video.mp4", {
      now: new Date("2026-08-11T12:00:00.000Z"),
      randomUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      randomPostfix: "deadbeefcafebabe",
    });
    expect(name).toBe("2026/08/11/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/Video-deadbeefcafebabe.mp4");
  });

  it("produces unique names across calls", () => {
    const a = buildOpaqueBlobName("a.bin");
    const b = buildOpaqueBlobName("a.bin");
    expect(a).not.toBe(b);
  });
});

describe("formatOversizedAttachmentNote", () => {
  const uploaded: UploadedAzureBlobLink = {
    fileName: "big.mp4",
    blobName: "2026/08/11/u/big-x.mp4",
    url: "https://example.blob.core.windows.net/c/big?sv=1&sig=abc",
    expiresAt: new Date("2026-08-14T00:00:00.000Z"),
    sizeBytes: 12_500_000,
  };

  it("formats temporary download links for uploaded files", () => {
    const note = formatOversizedAttachmentNote({ uploaded: [uploaded], failed: [] });
    expect(note).toContain("temporary download links (expire in 3 days)");
    expect(note).toContain("[`big.mp4`](https://example.blob.core.windows.net/c/big?sv=1&sig=abc)");
    expect(note).toContain("(13 MB)");
  });

  it("formats failure-only notes when Azure is unavailable", () => {
    const note = formatOversizedAttachmentNote({
      uploaded: [],
      failed: [],
      unconfigured: [{ fileName: "huge.zip", sizeBytes: 20_000_000 }],
    });
    expect(note).toContain("could not be attached due to Discord upload limits");
    expect(note).toContain("`huge.zip`");
    expect(note).toContain("(20 MB)");
  });

  it("returns null when there is nothing to report", () => {
    expect(formatOversizedAttachmentNote({ uploaded: [], failed: [] })).toBeNull();
  });
});

describe("constants", () => {
  it("keeps the Discord offload threshold at 10MB", () => {
    expect(DISCORD_CONSERVATIVE_UPLOAD_LIMIT_BYTES).toBe(10_000_000);
  });

  it("keeps the SAS TTL at three days", () => {
    expect(AZURE_BLOB_LINK_TTL_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });
});
