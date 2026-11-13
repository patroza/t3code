import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";

const files = new Map<
  string,
  { base64: string; deleted: boolean; text?: string; mimeType?: string }
>();

const clipboard = vi.hoisted(() => ({
  hasImageAsync: vi.fn(),
  getImageAsync: vi.fn(),
  hasStringAsync: vi.fn(),
  getStringAsync: vi.fn(),
}));

vi.mock("expo-clipboard", () => clipboard);

const requestMediaLibraryPermissionsAsync = vi.fn();
const launchImageLibraryAsync = vi.fn();
/** A native image renderer that reports the source size the test gives it. */
const manipulator = vi.hoisted(() => {
  const state = { sourceSize: { width: 0, height: 0 }, renderedBase64: "cmVuZGVyZWQ=" };
  const manipulate = vi.fn((source: string | { width: number; height: number }) => {
    let size = typeof source === "string" ? state.sourceSize : source;
    const context = {
      resize: vi.fn((next: { width: number; height: number }) => {
        size = next;
        return context;
      }),
      renderAsync: vi.fn(async () => ({
        ...size,
        release: vi.fn(),
        saveAsync: vi.fn(async (options: { format: string }) => {
          const uri = `file:///cache/rendered.${options.format}`;
          files.set(uri, { base64: state.renderedBase64, deleted: false });
          return { uri, base64: state.renderedBase64 };
        }),
      })),
    };
    return context;
  });
  return { state, manipulate };
});

vi.mock("expo-image-manipulator", () => ({
  ImageManipulator: { manipulate: manipulator.manipulate },
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
}));

vi.mock("expo-file-system", () => ({
  File: class {
    readonly uri: string;
    readonly name: string;
    readonly parentDirectory: { readonly uri: string };

    constructor(parent: string | { readonly uri: string }, name?: string) {
      const parentUri = typeof parent === "string" ? parent : parent.uri;
      this.uri = name ? `${parentUri}/${name}` : parentUri;
      this.name = name ?? this.uri.split("/").at(-1) ?? "file";
      this.parentDirectory = { uri: this.uri.slice(0, -(this.name.length + 1)) };
    }

    get exists(): boolean {
      return files.has(this.uri) && files.get(this.uri)?.deleted === false;
    }

    get size(): number {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) return 0;
      if (entry.text !== undefined) return new TextEncoder().encode(entry.text).byteLength;
      if (!entry.base64) return 0;
      const padding = entry.base64.endsWith("==") ? 2 : entry.base64.endsWith("=") ? 1 : 0;
      return Math.floor((entry.base64.length * 3) / 4) - padding;
    }

    get type(): string {
      return files.get(this.uri)?.mimeType ?? "";
    }

    async copy(destination: { readonly uri: string }): Promise<void> {
      const entry = files.get(this.uri);
      if (!entry) throw new Error("missing file");
      files.set(destination.uri, { ...entry });
    }

    async base64(): Promise<string> {
      const entry = files.get(this.uri);
      if (!entry || entry.deleted) {
        throw new Error("missing file");
      }
      return entry.base64;
    }

    delete(): void {
      const entry = files.get(this.uri);
      if (entry) {
        entry.deleted = true;
      }
    }

    create(): void {
      files.set(this.uri, { base64: "", deleted: false });
    }

    write(text: string): void {
      files.set(this.uri, { base64: "", deleted: false, text });
    }

    moveSync(destination: { readonly uri: string }): void {
      const entry = files.get(this.uri);
      if (!entry) throw new Error("missing staged file");
      files.set(destination.uri, entry);
      files.delete(this.uri);
    }
  },
  Directory: class {
    readonly uri: string;

    constructor(parent: string, name: string) {
      this.uri = `${parent}/${name}`;
    }

    create(): void {}
  },
  FileMode: { ReadOnly: "r", WriteOnly: "w" },
  Paths: { document: "file:///documents" },
}));

vi.mock("expo-image-picker", () => ({
  requestMediaLibraryPermissionsAsync,
  launchImageLibraryAsync,
}));

vi.mock("./uuid", () => ({
  uuidv4: () => "attachment-id",
}));

import {
  convertPastedImagesToAttachments,
  persistComposerAttachmentFile,
  pasteComposerClipboard,
  pickComposerImages,
} from "./composerImages";

describe("pickComposerImages", () => {
  beforeEach(() => {
    files.clear();
    requestMediaLibraryPermissionsAsync.mockReset();
    launchImageLibraryAsync.mockReset();
  });

  it("opens the system image library without requesting media-library permission", async () => {
    files.set("file:///tmp/photo.png", { base64: "aGVsbG8=", deleted: false });
    launchImageLibraryAsync.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///tmp/photo.png",
          fileName: "photo.png",
          mimeType: "image/png",
          fileSize: 5,
        },
      ],
    });

    const result = await pickComposerImages({ existingCount: 0 });

    expect(requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
    expect(launchImageLibraryAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        base64: false,
      }),
    );
    expect(result).toEqual({
      images: [
        expect.objectContaining({
          id: "attachment-id",
          type: "image",
          name: "photo.png",
          mimeType: "image/png",
          sizeBytes: 5,
          dataUrl: "data:image/png;base64,aGVsbG8=",
          previewUri: "file:///tmp/photo.png",
        }),
      ],
      error: null,
    });
  });

  it("returns no images when the user cancels the picker", async () => {
    launchImageLibraryAsync.mockResolvedValue({
      canceled: true,
      assets: null,
    });

    await expect(pickComposerImages({ existingCount: 0 })).resolves.toEqual({
      images: [],
      error: null,
    });
    expect(requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  });

  it("returns a structured error when the image library fails to open", async () => {
    launchImageLibraryAsync.mockRejectedValue(new Error("picker unavailable"));

    await expect(pickComposerImages({ existingCount: 0 })).resolves.toEqual({
      images: [],
      error: "picker unavailable",
    });
    expect(requestMediaLibraryPermissionsAsync).not.toHaveBeenCalled();
  });

  it("rejects picks when the attachment limit is already full", async () => {
    await expect(
      pickComposerImages({ existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }),
    ).resolves.toEqual({
      images: [],
      error: `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments per message.`,
    });
    expect(launchImageLibraryAsync).not.toHaveBeenCalled();
  });
});

describe("composer clipboard paste", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clipboard.hasImageAsync.mockResolvedValue(false);
    clipboard.hasStringAsync.mockResolvedValue(true);
    clipboard.getStringAsync.mockResolvedValue("clipboard text");
    clipboard.getImageAsync.mockResolvedValue({ data: "data:image/png;base64,aGVsbG8=" });
  });

  it("returns only the image when the clipboard contains both image and text", async () => {
    clipboard.hasImageAsync.mockResolvedValue(true);
    const result = await pasteComposerClipboard({ existingCount: 0 });
    expect(result).toEqual({
      images: [expect.objectContaining({ type: "image", name: "pasted-image.png" })],
      text: null,
      error: null,
    });
    expect(clipboard.getStringAsync).not.toHaveBeenCalled();
  });

  it("does not paste alternate text when the image cannot fit", async () => {
    clipboard.hasImageAsync.mockResolvedValue(true);
    expect(
      await pasteComposerClipboard({ existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }),
    ).toEqual({ images: [], text: null, error: expect.stringContaining("up to") });
    expect(clipboard.getStringAsync).not.toHaveBeenCalled();
  });
});

describe("oversized pasted images", () => {
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const pngDataUrl = (width: number, height: number) =>
    `data:image/png;base64,${Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...u32(13),
      0x49,
      0x48,
      0x44,
      0x52,
      ...u32(width),
      ...u32(height),
      8,
      6,
      0,
      0,
      0,
    ]).toString("base64")}`;

  beforeEach(() => {
    vi.clearAllMocks();
    clipboard.hasImageAsync.mockResolvedValue(true);
  });

  it("scales a clipboard screenshot over 2000px to 2000px and keeps it a PNG", async () => {
    manipulator.state.sourceSize = { width: 3024, height: 1964 };
    const pasted = pngDataUrl(3024, 1964);
    clipboard.getImageAsync.mockResolvedValue({ data: pasted });

    const result = await pasteComposerClipboard({ existingCount: 0 });

    expect(manipulator.manipulate).toHaveBeenCalledWith(pasted);
    const resize = manipulator.manipulate.mock.results.at(-1)?.value.resize;
    expect(resize).toHaveBeenCalledWith({ width: 2000, height: 1299 });
    expect(result.images).toEqual([
      expect.objectContaining({
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,cmVuZGVyZWQ=",
        previewUri: "data:image/png;base64,cmVuZGVyZWQ=",
      }),
    ]);
  });
});

function oversizedPng(): string {
  const png = Buffer.alloc(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
  png.write("IHDR", 12);
  png.writeUInt32BE(2000, 16);
  png.writeUInt32BE(2000, 20);
  return png.toString("base64");
}

describe("native pasted image cleanup", () => {
  beforeEach(() => {
    files.clear();
    manipulator.state.renderedBase64 = "cmVuZGVyZWQ=";
  });

  it("preserves the reported image type of extensionless Android content URIs", async () => {
    const uri = "content://media/external/images/media/42";
    files.set(uri, { base64: "aGVsbG8=", deleted: false, mimeType: "image/jpeg" });

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        name: "pasted-image.jpeg",
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,aGVsbG8=",
        previewUri: "data:image/jpeg;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(false);
  });

  it("renders unsupported images to JPEG and removes the cache file after attaching", async () => {
    const uri = "content://media/external/images/media/43";
    files.set(uri, { base64: "b3JpZ2luYWw=", deleted: false, mimeType: "image/heic" });
    manipulator.state.sourceSize = { width: 100, height: 100 };

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        name: "pasted-image.jpeg",
        mimeType: "image/jpeg",
        dataUrl: "data:image/jpeg;base64,cmVuZGVyZWQ=",
        previewUri: "data:image/jpeg;base64,cmVuZGVyZWQ=",
      }),
    ]);
    expect(files.get("file:///cache/rendered.jpeg")?.deleted).toBe(true);
    expect(files.get(uri)?.deleted).toBe(false);
  });

  it("removes the rendered JPEG when its bytes exceed the image limit", async () => {
    const uri = "content://media/external/images/media/43";
    files.set(uri, { base64: "b3JpZ2luYWw=", deleted: false, mimeType: "image/heic" });
    manipulator.state.sourceSize = { width: 100, height: 100 };
    manipulator.state.renderedBase64 = "A".repeat(
      Math.ceil((PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1) / 3) * 4,
    );

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([]);
    expect(files.get("file:///cache/rendered.jpeg")?.deleted).toBe(true);
    expect(files.get(uri)?.deleted).toBe(false);
  });

  it("converts owned files to data-backed previews and deletes the source", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/id.png";
    files.set(uri, { base64: "aGVsbG8=", deleted: false });

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toEqual([
      expect.objectContaining({
        dataUrl: "data:image/png;base64,aGVsbG8=",
        previewUri: "data:image/png;base64,aGVsbG8=",
      }),
    ]);
    expect(files.get(uri)?.deleted).toBe(true);
  });

  it("deletes rejected and overflow owned files without deleting user-owned files", async () => {
    const rejected =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/bad.png";
    const overflow =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/overflow.png";
    const userOwned = "file:///private/var/mobile/photos/library.png";
    files.set(rejected, { base64: "", deleted: false });
    files.set(overflow, { base64: "aGVsbG8=", deleted: false });
    files.set(userOwned, { base64: "aGVsbG8=", deleted: false });

    await convertPastedImagesToAttachments({
      uris: [rejected, overflow, userOwned],
      existingCount: PROVIDER_SEND_TURN_MAX_ATTACHMENTS - 1,
    });

    expect(files.get(rejected)?.deleted).toBe(true);
    expect(files.get(overflow)?.deleted).toBe(true);
    expect(files.get(userOwned)?.deleted).toBe(false);
  });

  it("re-renders an over-limit paste whose dimensions already fit, like the photo picker", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/photo.png";
    files.set(uri, { base64: oversizedPng(), deleted: false });
    manipulator.state.sourceSize = { width: 2000, height: 2000 };

    const { attachments } = await convertPastedImagesToAttachments({
      uris: [uri],
      existingCount: 0,
    });

    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.sizeBytes).toBeLessThanOrEqual(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
    expect(files.get("file:///cache/rendered.jpeg")?.deleted).toBe(true);
  });

  it("keeps the readable images of a paste and still reports the one it dropped", async () => {
    const gone =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/gone.png";
    const kept =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/kept.png";
    files.set(kept, { base64: "aGVsbG8=", deleted: false });

    const result = await convertPastedImagesToAttachments({ uris: [gone, kept], existingCount: 0 });

    expect(result.attachments).toEqual([
      expect.objectContaining({ dataUrl: "data:image/png;base64,aGVsbG8=" }),
    ]);
    expect(result.error).toBe("Could not read a pasted image.");
  });

  it("reports the size limit when even the JPEG re-render is too large", async () => {
    const uri =
      "file:///private/var/mobile/Containers/Data/Application/app/tmp/t3-composer-paste/huge.png";
    files.set(uri, { base64: oversizedPng(), deleted: false });
    manipulator.state.sourceSize = { width: 2000, height: 2000 };
    manipulator.state.renderedBase64 = oversizedPng();

    const result = await convertPastedImagesToAttachments({ uris: [uri], existingCount: 0 });

    expect(result).toEqual({
      attachments: [],
      error: "A pasted image exceeds the 10 MB attachment limit.",
    });
    expect(files.get(uri)?.deleted).toBe(true);
  });
});

describe("persistComposerAttachmentFile", () => {
  beforeEach(() => {
    files.clear();
  });

  it("stores picked files under a name Android's java.net.URI accepts", async () => {
    const source = "file:///cache/DocumentPicker/Report [draft].pdf";
    files.set(source, { base64: "JVBERg==", deleted: false });

    const fileUri = await persistComposerAttachmentFile(source, "Report [draft].pdf");

    // expo-file-system encodes spaces and `%` but leaves `[`, `]`, `|` and `^` raw.
    expect(fileUri.split("/").at(-1)).toMatch(/^[\w\-.!~*'();:@&=+$, %]+\.pdf$/);
  });
});

describe("composerStripAttachments", () => {
  const image = {
    id: "img-1",
    type: "image" as const,
    name: "shot.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 10,
    dataUrl: "",
  };
  const video = {
    id: "vid-1",
    type: "file" as const,
    name: "clip.mp4",
    mimeType: "video/mp4",
    sizeBytes: 20,
    fileUri: "file:///clip.mp4",
  };
  const doc = {
    id: "doc-1",
    type: "file" as const,
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 5,
    fileUri: "file:///notes.txt",
  };

  it("keeps media beside a document rather than dropping the whole strip", async () => {
    const { composerStripAttachments } = await import("./composerImages");
    expect(composerStripAttachments([doc, image, video] as never).map((a) => a.id)).toEqual([
      "img-1",
      "vid-1",
    ]);
  });

  it("keeps oversized document-picked images visible while sending them as files", async () => {
    const { composerStripAttachments, isComposerImageAttachment } =
      await import("./composerImages");
    const oversizedImage = {
      ...video,
      id: "large-image",
      name: "large.png",
      mimeType: "image/png",
      fileUri: "file:///large.png",
      sizeBytes: PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1,
    };

    expect(composerStripAttachments([oversizedImage])).toEqual([oversizedImage]);
    expect(isComposerImageAttachment(oversizedImage)).toBe(false);
  });
});
