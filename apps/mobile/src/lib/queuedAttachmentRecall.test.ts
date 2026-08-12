import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// `./uuid` pulls in expo-crypto (and through it react-native), which cannot be
// loaded in this environment; the sibling composer-image test mocks it the same way.
let recalledIdCounter = 0;
vi.mock("./uuid", () => ({
  uuidv4: () => `recalled-${(recalledIdCounter += 1)}`,
}));

import {
  describeQueuedAttachmentCapacity,
  formatMissingAttachmentsError,
  recallQueuedAttachments,
  type QueuedAttachmentRecallDeps,
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

const deps = (overrides: Partial<QueuedAttachmentRecallDeps> = {}): QueuedAttachmentRecallDeps => ({
  urlById: new Map([["attachment-1", "https://assets.test/attachment-1"]]),
  fetchDataUrl: async () => "data:image/png;base64,cG5nIQ==",
  ...overrides,
});

describe("recallQueuedAttachments", () => {
  it("rebuilds a draft attachment carrying the bytes inline", async () => {
    const result = await recallQueuedAttachments([attachment()], deps());

    expect(result.missing).toEqual([]);
    expect(result.images).toHaveLength(1);
    const image = result.images[0]!;
    expect(image.type).toBe("image");
    expect(image.name).toBe("screenshot.png");
    expect(image.mimeType).toBe("image/png");
    expect(image.sizeBytes).toBe(4);
    expect(image.dataUrl).toBe("data:image/png;base64,cG5nIQ==");
    expect(image.previewUri).toBe("data:image/png;base64,cG5nIQ==");
  });

  it("gives the recalled draft a fresh id so it outlives the removed queue entry", async () => {
    const result = await recallQueuedAttachments([attachment()], deps());

    expect(result.images[0]!.id).not.toBe("attachment-1");
    expect(result.images[0]!.id).toMatch(/^recalled-/);
  });

  it("reads each attachment from its own signed url", async () => {
    const requested: string[] = [];
    const result = await recallQueuedAttachments(
      [attachment(), attachment({ id: "attachment-2", name: "diagram.png" })],
      deps({
        urlById: new Map([
          ["attachment-1", "https://assets.test/one"],
          ["attachment-2", "https://assets.test/two"],
        ]),
        fetchDataUrl: async (url: string) => {
          requested.push(url);
          return "data:image/png;base64,eA==";
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

  it("keeps the readable attachments when one read fails", async () => {
    const result = await recallQueuedAttachments(
      [attachment(), attachment({ id: "attachment-2", name: "broken.png" })],
      deps({
        urlById: new Map([
          ["attachment-1", "https://assets.test/one"],
          ["attachment-2", "https://assets.test/two"],
        ]),
        fetchDataUrl: async (url: string) => {
          if (url.endsWith("two")) throw new Error("gone");
          return "data:image/png;base64,eA==";
        },
      }),
    );

    expect(result.images.map((image) => image.name)).toEqual(["screenshot.png"]);
    expect(result.missing).toEqual(["broken.png"]);
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
      "'screenshot.png' could not be loaded, so the message is still queued. Try again — if it keeps failing, the image is no longer on the server and the message has to be sent or replaced as it is.",
    );
  });

  it("counts them once several were left behind", () => {
    expect(formatMissingAttachmentsError(["a.png", "b.png"])).toBe(
      "2 attachments could not be loaded, so the message is still queued. Try again — if it keeps failing, the image is no longer on the server and the message has to be sent or replaced as it is.",
    );
  });
});

describe("describeQueuedAttachmentCapacity", () => {
  it("allows an edit that fits in the composer", () => {
    expect(describeQueuedAttachmentCapacity(3, 2)).toBeNull();
  });

  it("allows an edit that exactly fills the remaining room", () => {
    expect(describeQueuedAttachmentCapacity(3, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 3)).toBeNull();
  });

  it("refuses an edit that would overflow, rather than restoring only some pictures", () => {
    const message = describeQueuedAttachmentCapacity(3, PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 2);

    expect(message).toContain(`${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-image limit`);
    expect(message).toContain("Remove some images from the composer first.");
  });

  it("says image, singular, for one attachment", () => {
    expect(describeQueuedAttachmentCapacity(1, PROVIDER_SEND_TURN_MAX_ATTACHMENTS)).toContain(
      "bring back 1 image,",
    );
  });

  it("never blocks a message with no attachments", () => {
    expect(describeQueuedAttachmentCapacity(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS)).toBeNull();
  });
});
