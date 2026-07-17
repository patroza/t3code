// @effect-diagnostics nodeBuiltinImport:off - VS Code extension host persistence uses Node's filesystem directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as vscode from "vscode";

interface FavoriteEntry {
  readonly provider: string;
  readonly model: string;
}

interface DesktopServerRuntime {
  readonly origin?: unknown;
}

export async function readDesktopServerUrl(): Promise<string | null> {
  for (const candidate of [
    NodePath.join(NodeOS.homedir(), ".t3", "userdata", "server-runtime.json"),
    NodePath.join(NodeOS.homedir(), ".t3", "dev", "server-runtime.json"),
  ]) {
    try {
      const runtime = JSON.parse(
        await NodeFS.promises.readFile(candidate, "utf8"),
      ) as DesktopServerRuntime;
      if (typeof runtime.origin === "string" && runtime.origin.trim() !== "") {
        return new URL(runtime.origin).toString();
      }
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
  }
  return null;
}

export async function readDesktopBootstrapCredential(): Promise<string | null> {
  for (const candidate of [
    NodePath.join(NodeOS.homedir(), ".t3", "userdata", "local-bootstrap-credential"),
    NodePath.join(NodeOS.homedir(), ".t3", "dev", "local-bootstrap-credential"),
  ]) {
    try {
      const credential = (await NodeFS.promises.readFile(candidate, "utf8")).trim();
      if (credential !== "") return credential;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") continue;
    }
  }
  return null;
}

function isFavoriteEntry(value: unknown): value is FavoriteEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "model" in value &&
    typeof value.model === "string"
  );
}

function parseDocument(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("T3 desktop client settings are not a JSON object.");
  }
  return value as Record<string, unknown>;
}

export class DesktopFavoritesStore implements vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  #watcher: vscode.FileSystemWatcher | null = null;
  #settingsPath = "";
  #favorites: ReadonlyArray<FavoriteEntry> = [];
  #providerFavorites: ReadonlyArray<string> = [];

  readonly onDidChange = this.#changed.event;

  get providerIds(): ReadonlyArray<string> {
    return this.#providerFavorites;
  }

  get modelKeys(): ReadonlyArray<string> {
    return this.#favorites.map((favorite) => `${favorite.provider}:${favorite.model}`);
  }

  async initialize(): Promise<void> {
    this.#settingsPath = await this.#resolveSettingsPath();
    await this.#reload();
    this.#watcher?.dispose();
    this.#watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        NodePath.dirname(this.#settingsPath),
        NodePath.basename(this.#settingsPath),
      ),
    );
    this.#watcher.onDidChange(() => void this.#reload());
    this.#watcher.onDidCreate(() => void this.#reload());
    this.#watcher.onDidDelete(() => {
      this.#favorites = [];
      this.#providerFavorites = [];
      this.#changed.fire();
    });
  }

  async toggleProvider(instanceId: string): Promise<void> {
    await this.#update((document) => {
      const favorites = Array.isArray(document.providerFavorites)
        ? document.providerFavorites.filter((value): value is string => typeof value === "string")
        : [];
      const index = favorites.indexOf(instanceId);
      if (index >= 0) favorites.splice(index, 1);
      else favorites.push(instanceId);
      document.providerFavorites = favorites;
    });
  }

  async toggleModel(modelKey: string): Promise<void> {
    const separator = modelKey.indexOf(":");
    if (separator <= 0 || separator === modelKey.length - 1) {
      throw new Error("Invalid model favorite.");
    }
    await this.#toggle(modelKey.slice(0, separator), modelKey.slice(separator + 1));
  }

  dispose(): void {
    this.#watcher?.dispose();
    this.#changed.dispose();
  }

  async #resolveSettingsPath(): Promise<string> {
    const configured = vscode.workspace
      .getConfiguration("t3Code")
      .get<string>("desktopClientSettingsPath", "")
      .trim();
    if (configured !== "") return configured.replace(/^~/u, NodeOS.homedir());
    const candidates = [
      NodePath.join(NodeOS.homedir(), ".t3", "userdata", "client-settings.json"),
      NodePath.join(NodeOS.homedir(), ".t3", "dev", "client-settings.json"),
    ];
    for (const candidate of candidates) {
      try {
        await NodeFS.promises.access(candidate);
        return candidate;
      } catch {
        // Try the next desktop channel.
      }
    }
    return candidates[0]!;
  }

  async #reload(): Promise<void> {
    try {
      const document = parseDocument(await NodeFS.promises.readFile(this.#settingsPath, "utf8"));
      this.#favorites = Array.isArray(document.favorites)
        ? document.favorites.filter(isFavoriteEntry)
        : [];
      this.#providerFavorites = Array.isArray(document.providerFavorites)
        ? document.providerFavorites.filter((value): value is string => typeof value === "string")
        : [];
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      this.#favorites = [];
      this.#providerFavorites = [];
    }
    this.#changed.fire();
  }

  async #toggle(provider: string, model: string): Promise<void> {
    await this.#update((document) => {
      const favorites = Array.isArray(document.favorites)
        ? document.favorites.filter(isFavoriteEntry)
        : [];
      const index = favorites.findIndex(
        (favorite) => favorite.provider === provider && favorite.model === model,
      );
      if (index >= 0) favorites.splice(index, 1);
      else favorites.push({ provider, model });
      document.favorites = favorites;
    });
  }

  async #update(mutate: (document: Record<string, unknown>) => void): Promise<void> {
    let document: Record<string, unknown> = {};
    try {
      document = parseDocument(await NodeFS.promises.readFile(this.#settingsPath, "utf8"));
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    mutate(document);
    await NodeFS.promises.mkdir(NodePath.dirname(this.#settingsPath), { recursive: true });
    const temporaryPath = `${this.#settingsPath}.${process.pid}.tmp`;
    await NodeFS.promises.writeFile(temporaryPath, `${JSON.stringify(document)}\n`, "utf8");
    await NodeFS.promises.rename(temporaryPath, this.#settingsPath);
    await this.#reload();
  }
}
