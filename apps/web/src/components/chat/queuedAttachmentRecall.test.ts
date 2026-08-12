import { describe, expect, it } from "vite-plus/test";

import {
  formatMissingAttachmentsError,
  recallQueuedAttachments,
  type RecallableQueuedAttachment,
} from "./queuedAttachmentRecall";

const attachment = (
  overrides: Partial<RecallableQueuedAttachment> = {},
): RecallableQueuedAttachment => ({
  id: "attachment-1",
  name: "screenshot.png",
  mimeType: "image/png",
  sizeBytes: 4,
  ...overrides,
});

const deps = (overrides: Partial<Parameters<typeof recallQueuedAttachments>[1]> = {}) => ({
  urlById: new Map([["attachment-1", "https://assets.test/attachment-1"]]),
  fetchBlob: async () => new Blob(["png!"], { type: "image/png" }),
  createObjectUrl: (file: File) => `blob:${file.name}`,
  ...overrides,
});

describe("recallQueuedAttachments", () => {
  it("rebuilds a composer image with the bytes fetched back", async () => {
    const result = await recallQueuedAttachments([attachment()], deps());

    expect(result.missing).toEqual([]);
    expect(result.images).toHaveLength(1);
    const image = result.images[0]!;
    expect(image.type).toBe("image");
    expect(image.name).toBe("screenshot.png");
    expect(image.mimeType).toBe("image/png");
    expect(image.sizeBytes).toBe(4);
    expect(image.previewUrl).toBe("blob:screenshot.png");
    expect(image.file).toBeInstanceOf(File);
    expect(await image.file.text()).toBe("png!");
  });

  it("gives the recalled draft a fresh id so it outlives the removed queue entry", async () => {
    const result = await recallQueuedAttachments([attachment()], deps());

    expect(result.images[0]!.id).not.toBe("attachment-1");
  });

  it("fetches each attachment from its own signed url", async () => {
    const requested: string[] = [];
    const result = await recallQueuedAttachments(
      [attachment(), attachment({ id: "attachment-2", name: "diagram.png" })],
      deps({
        urlById: new Map([
          ["attachment-1", "https://assets.test/one"],
          ["attachment-2", "https://assets.test/two"],
        ]),
        fetchBlob: async (url: string) => {
          requested.push(url);
          return new Blob(["x"], { type: "image/png" });
        },
      }),
    );

    expect(requested).toEqual(["https://assets.test/one", "https://assets.test/two"]);
    expect(result.images.map((image) => image.name)).toEqual(["screenshot.png", "diagram.png"]);
  });

  it("reports an attachment whose url has not resolved instead of dropping it silently", async () => {
    const result = await recallQueuedAttachments([attachment()], deps({ urlById: new Map() }));

    expect(result.images).toEqual([]);
    expect(result.missing).toEqual(["screenshot.png"]);
  });

  it("keeps the readable attachments when one fetch fails", async () => {
    const result = await recallQueuedAttachments(
      [attachment(), attachment({ id: "attachment-2", name: "broken.png" })],
      deps({
        urlById: new Map([
          ["attachment-1", "https://assets.test/one"],
          ["attachment-2", "https://assets.test/two"],
        ]),
        fetchBlob: async (url: string) => {
          if (url.endsWith("two")) throw new Error("gone");
          return new Blob(["x"], { type: "image/png" });
        },
      }),
    );

    expect(result.images.map((image) => image.name)).toEqual(["screenshot.png"]);
    expect(result.missing).toEqual(["broken.png"]);
  });

  it("falls back to the blob's own type when the queued mime type is empty", async () => {
    const result = await recallQueuedAttachments(
      [attachment({ mimeType: "" })],
      deps({ fetchBlob: async () => new Blob(["x"], { type: "image/webp" }) }),
    );

    expect(result.images[0]!.mimeType).toBe("image/webp");
  });

  it("returns nothing for a queued message with no attachments", async () => {
    const result = await recallQueuedAttachments([], deps());

    expect(result).toEqual({ images: [], missing: [] });
  });
});

describe("formatMissingAttachmentsError", () => {
  it("stays silent when everything was restored", () => {
    expect(formatMissingAttachmentsError([])).toBeNull();
  });

  it("names the single attachment that was left behind", () => {
    expect(formatMissingAttachmentsError(["screenshot.png"])).toBe(
      "'screenshot.png' could not be restored for editing and was left off the message.",
    );
  });

  it("counts them once several were left behind", () => {
    expect(formatMissingAttachmentsError(["a.png", "b.png"])).toBe(
      "2 attachments could not be restored for editing and were left off the message.",
    );
  });
});
