import { describe, expect, it } from "vite-plus/test";

import {
  addPromptStashEntry,
  fitPromptStashImages,
  type PromptStashEntry,
} from "./promptStashModel.ts";

function entry(id: string, providerInstanceId: string): PromptStashEntry {
  return {
    id,
    createdAt: "2026-07-28T00:00:00.000Z",
    prompt: id,
    images: [],
    droppedImageNames: [],
    providerInstanceId,
    modelSelection: null,
    interactionMode: "default",
  };
}

describe("addPromptStashEntry", () => {
  it("caps each provider queue independently", () => {
    const existing = [
      ...Array.from({ length: 20 }, (_, index) => entry(`a-${index}`, "a")),
      entry("b-0", "b"),
    ];

    const next = addPromptStashEntry(existing, entry("a-new", "a"));

    expect(next.filter((candidate) => candidate.providerInstanceId === "a")).toHaveLength(20);
    expect(next[0]?.id).toBe("a-new");
    expect(next.some((candidate) => candidate.id === "a-19")).toBe(false);
    expect(next.some((candidate) => candidate.id === "b-0")).toBe(true);
  });

  it("bounds attachment data stored for an entry", () => {
    const image = (name: string, chars: number) => ({
      type: "image" as const,
      name,
      mimeType: "image/png",
      sizeBytes: chars,
      dataUrl: "x".repeat(chars),
    });

    const result = fitPromptStashImages([
      image("first.png", 2_000_000),
      image("second.png", 800_000),
    ]);

    expect(result.images.map(({ name }) => name)).toEqual(["first.png"]);
    expect(result.droppedImageNames).toEqual(["second.png"]);
  });
});
