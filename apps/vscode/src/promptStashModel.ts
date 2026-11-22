import type { ModelSelection, UploadChatAttachment } from "@t3tools/contracts";

export interface PromptStashEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly prompt: string;
  readonly images: ReadonlyArray<UploadChatAttachment>;
  readonly droppedImageNames: ReadonlyArray<string>;
  readonly providerInstanceId: string | null;
  readonly modelSelection: ModelSelection | null;
  readonly interactionMode: "default" | "plan";
}

const MAX_ENTRIES_PER_PROVIDER = 20;
const MAX_TOTAL_ENTRIES = 100;
const MAX_ENTRY_IMAGE_CHARS = 2_700_000;

export function fitPromptStashImages(
  images: ReadonlyArray<UploadChatAttachment>,
): Pick<PromptStashEntry, "images" | "droppedImageNames"> {
  let used = 0;
  const kept: UploadChatAttachment[] = [];
  const droppedImageNames: string[] = [];
  for (const image of images) {
    if (used + image.dataUrl.length > MAX_ENTRY_IMAGE_CHARS) {
      droppedImageNames.push(image.name);
      continue;
    }
    used += image.dataUrl.length;
    kept.push(image);
  }
  return { images: kept, droppedImageNames };
}

export function addPromptStashEntry(
  entries: ReadonlyArray<PromptStashEntry>,
  entry: PromptStashEntry,
): ReadonlyArray<PromptStashEntry> {
  let scopeEntries = 0;
  return [entry, ...entries]
    .filter((candidate) => {
      if (candidate.providerInstanceId !== entry.providerInstanceId) return true;
      scopeEntries += 1;
      return scopeEntries <= MAX_ENTRIES_PER_PROVIDER;
    })
    .slice(0, MAX_TOTAL_ENTRIES);
}

export const MAX_PERSISTED_PROMPT_STASH_ENTRIES = MAX_TOTAL_ENTRIES;
