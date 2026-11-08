import * as vscode from "vscode";

import {
  addPromptStashEntry,
  MAX_PERSISTED_PROMPT_STASH_ENTRIES,
  type PromptStashEntry,
} from "./promptStashModel.ts";
export type { PromptStashEntry } from "./promptStashModel.ts";

interface PersistedPromptStash {
  readonly version: 1;
  readonly entries: ReadonlyArray<PromptStashEntry>;
}

const FILE_NAME = "prompt-stash-v1.json";

function isEntry(value: unknown): value is PromptStashEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<PromptStashEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.createdAt === "string" &&
    typeof entry.prompt === "string" &&
    Array.isArray(entry.images) &&
    Array.isArray(entry.droppedImageNames) &&
    (entry.providerInstanceId === null || typeof entry.providerInstanceId === "string") &&
    (entry.modelSelection === null ||
      (typeof entry.modelSelection === "object" && entry.modelSelection !== null)) &&
    (entry.interactionMode === "default" || entry.interactionMode === "plan")
  );
}

export class PromptStashStore {
  readonly #storageUri: vscode.Uri | undefined;
  #entries: ReadonlyArray<PromptStashEntry> | null = null;
  #write: Promise<void> = Promise.resolve();

  constructor(storageUri: vscode.Uri | undefined) {
    this.#storageUri = storageUri;
  }

  async list(providerInstanceId: string | null): Promise<ReadonlyArray<PromptStashEntry>> {
    const entries = await this.#load();
    return entries.filter((entry) => entry.providerInstanceId === providerInstanceId);
  }

  async add(entry: PromptStashEntry): Promise<ReadonlyArray<PromptStashEntry>> {
    const entries = await this.#load();
    this.#entries = addPromptStashEntry(entries, entry);
    await this.#persist();
    return this.list(entry.providerInstanceId);
  }

  async take(id: string): Promise<PromptStashEntry | null> {
    const entries = await this.#load();
    const entry = entries.find((candidate) => candidate.id === id) ?? null;
    if (entry === null) return null;
    this.#entries = entries.filter((candidate) => candidate.id !== id);
    await this.#persist();
    return entry;
  }

  async remove(id: string): Promise<void> {
    const entries = await this.#load();
    const next = entries.filter((candidate) => candidate.id !== id);
    if (next.length === entries.length) return;
    this.#entries = next;
    await this.#persist();
  }

  async #load(): Promise<ReadonlyArray<PromptStashEntry>> {
    if (this.#entries !== null) return this.#entries;
    if (this.#storageUri === undefined) return (this.#entries = []);
    try {
      const bytes = await vscode.workspace.fs.readFile(
        vscode.Uri.joinPath(this.#storageUri, FILE_NAME),
      );
      const decoded: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (
        typeof decoded === "object" &&
        decoded !== null &&
        "version" in decoded &&
        decoded.version === 1 &&
        "entries" in decoded &&
        Array.isArray(decoded.entries)
      ) {
        return (this.#entries = decoded.entries
          .filter(isEntry)
          .slice(0, MAX_PERSISTED_PROMPT_STASH_ENTRIES));
      }
    } catch (cause) {
      if (!(cause instanceof vscode.FileSystemError && cause.code === "FileNotFound")) throw cause;
    }
    return (this.#entries = []);
  }

  async #persist(): Promise<void> {
    if (this.#storageUri === undefined) return;
    const payload: PersistedPromptStash = { version: 1, entries: this.#entries ?? [] };
    const bytes = new TextEncoder().encode(JSON.stringify(payload));
    this.#write = this.#write.then(async () => {
      await vscode.workspace.fs.createDirectory(this.#storageUri!);
      const target = vscode.Uri.joinPath(this.#storageUri!, FILE_NAME);
      const temporary = vscode.Uri.joinPath(this.#storageUri!, `${FILE_NAME}.tmp`);
      await vscode.workspace.fs.writeFile(temporary, bytes);
      await vscode.workspace.fs.rename(temporary, target, { overwrite: true });
    });
    await this.#write;
  }
}
