// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off tryCatchInEffectGen:off
/**
 * Bot-local shortName → workspaceRoot mapping.
 * The T3 server does not know about these aliases.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

const SHORT_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface ProjectAlias {
  readonly shortName: string;
  readonly workspaceRoot: string;
  /** Parent Discord text channel where GitHub-created T3 threads should be mirrored. */
  readonly discordChannelId?: string;
}

export class ProjectAliasesLoadError extends Schema.TaggedErrorClass<ProjectAliasesLoadError>()(
  "ProjectAliasesLoadError",
  {
    path: Schema.String,
    message: Schema.String,
  },
) {}

const isProjectAliasesLoadError = Schema.is(ProjectAliasesLoadError);

export function expandHomePath(value: string): string {
  if (!value) return value;
  if (value === "~") return NodeOS.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), value.slice(2));
  }
  return value;
}

export function normalizeProjectAliasShortName(raw: string): string | null {
  const shortName = raw.trim().toLowerCase();
  if (shortName.length === 0) return null;
  if (!SHORT_NAME_PATTERN.test(shortName)) return null;
  return shortName;
}

export function normalizeWorkspaceRootPath(raw: string): string {
  const expanded = expandHomePath(raw.trim());
  return expanded.replaceAll("\\", "/").replace(/\/+$/u, "") || expanded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Minimal YAML subset for flat maps and nested workspaceRoot form.
 * Prefer JSON when possible; full YAML is not required.
 */
export function parseSimpleAliasesYaml(raw: string): unknown {
  const lines = raw.split(/\r?\n/);
  const flat: Record<string, string> = {};
  const nested: Record<string, { workspaceRoot?: string; discordChannelId?: string }> = {};
  let inAliasesBlock = false;
  let currentKey: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    if (/^aliases:\s*$/.test(trimmed)) {
      inAliasesBlock = true;
      continue;
    }

    const nestedValueMatch = /^\s+(workspaceRoot|discordChannelId):\s*(.+)\s*$/.exec(line);
    if (nestedValueMatch && currentKey !== null) {
      const field = nestedValueMatch[1]! as "workspaceRoot" | "discordChannelId";
      const value = stripYamlScalar(nestedValueMatch[2]!);
      nested[currentKey] = { ...nested[currentKey], [field]: value };
      continue;
    }

    const nestedKeyMatch = /^\s{2,}([A-Za-z0-9][A-Za-z0-9_-]*):\s*$/.exec(line);
    if (nestedKeyMatch && inAliasesBlock) {
      currentKey = nestedKeyMatch[1]!;
      continue;
    }

    const flatMatch = /^([A-Za-z0-9][A-Za-z0-9_-]*):\s*(.+)\s*$/.exec(trimmed);
    if (flatMatch) {
      const key = flatMatch[1]!;
      const value = stripYamlScalar(flatMatch[2]!);
      if (key === "aliases") continue;
      flat[key] = value;
      currentKey = null;
      continue;
    }
  }

  if (Object.keys(nested).length > 0) {
    return { aliases: nested };
  }
  return flat;
}

function stripYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Accept either:
 *   example-project: ~/projects/example-project
 * or:
 *   aliases:
 *     example-project:
 *       workspaceRoot: ~/projects/example-project
 * or array of { shortName, workspaceRoot }.
 */
export function parseProjectAliasesDocument(
  document: unknown,
  options?: { readonly resolveRelativeTo?: string },
): ReadonlyArray<ProjectAlias> {
  const resolveRoot = (raw: string): string => {
    const expanded = expandHomePath(raw.trim());
    const absolute =
      options?.resolveRelativeTo !== undefined && !NodePath.isAbsolute(expanded)
        ? NodePath.resolve(options.resolveRelativeTo, expanded)
        : expanded;
    return normalizeWorkspaceRootPath(absolute);
  };

  const entries = new Map<string, string>();

  const add = (shortNameRaw: string, workspaceRootRaw: string, discordChannelIdRaw?: string) => {
    const shortName = normalizeProjectAliasShortName(shortNameRaw);
    if (shortName === null) {
      throw new Error(
        `Invalid project alias shortName '${shortNameRaw}'. Use lowercase letters, digits, and hyphens (e.g. example-project).`,
      );
    }
    const workspaceRoot = resolveRoot(workspaceRootRaw);
    if (workspaceRoot.trim().length === 0) {
      throw new Error(`Project alias '${shortName}' has an empty workspaceRoot.`);
    }
    if (entries.has(shortName)) {
      throw new Error(`Duplicate project alias shortName '${shortName}'.`);
    }
    entries.set(shortName, workspaceRoot);
    if (discordChannelIdRaw?.trim()) discordChannels.set(shortName, discordChannelIdRaw.trim());
  };

  const discordChannels = new Map<string, string>();

  if (Array.isArray(document)) {
    for (const item of document) {
      if (!isRecord(item)) {
        throw new Error("Project aliases array entries must be objects.");
      }
      const shortName = item.shortName;
      const workspaceRoot = item.workspaceRoot;
      if (typeof shortName !== "string" || typeof workspaceRoot !== "string") {
        throw new Error("Each project alias must include string shortName and workspaceRoot.");
      }
      add(
        shortName,
        workspaceRoot,
        typeof item.discordChannelId === "string" ? item.discordChannelId : undefined,
      );
    }
  } else if (isRecord(document)) {
    const aliasesNode = document.aliases;
    const source = isRecord(aliasesNode) ? aliasesNode : document;
    for (const [key, value] of Object.entries(source)) {
      if (key === "aliases" && source === document) continue;
      if (typeof value === "string") {
        add(key, value);
        continue;
      }
      if (isRecord(value) && typeof value.workspaceRoot === "string") {
        add(
          key,
          value.workspaceRoot,
          typeof value.discordChannelId === "string" ? value.discordChannelId : undefined,
        );
        continue;
      }
      throw new Error(
        `Project alias '${key}' must be a path string or an object with workspaceRoot.`,
      );
    }
  } else {
    throw new Error("Project aliases file must be a mapping, aliases object, or array.");
  }

  return [...entries.entries()]
    .map(([shortName, workspaceRoot]) => ({
      shortName,
      workspaceRoot,
      ...(discordChannels.has(shortName)
        ? { discordChannelId: discordChannels.get(shortName)! }
        : {}),
    }))
    .toSorted((left, right) => left.shortName.localeCompare(right.shortName));
}

export function loadProjectAliasesFromFileSync(filePath: string): ReadonlyArray<ProjectAlias> {
  const resolvedPath = NodePath.resolve(expandHomePath(filePath.trim()));
  if (!NodeFS.existsSync(resolvedPath)) {
    throw new ProjectAliasesLoadError({
      path: resolvedPath,
      message: `Project aliases file not found: ${resolvedPath}`,
    });
  }

  const raw = NodeFS.readFileSync(resolvedPath, "utf8");
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  let document: unknown;
  if (resolvedPath.endsWith(".json")) {
    document = JSON.parse(trimmed) as unknown;
  } else {
    document = parseSimpleAliasesYaml(trimmed);
  }

  return parseProjectAliasesDocument(document, {
    resolveRelativeTo: NodePath.dirname(resolvedPath),
  });
}

export interface ProjectAliasStoreService {
  readonly list: () => ReadonlyArray<ProjectAlias>;
  readonly resolve: (shortName: string) => ProjectAlias | null;
}

export class ProjectAliasStore extends Context.Service<
  ProjectAliasStore,
  ProjectAliasStoreService
>()("@t3tools/discord-bot/projectAliases/ProjectAliasStore") {}

export const makeProjectAliasStore = (aliases: ReadonlyArray<ProjectAlias>) =>
  ProjectAliasStore.of({
    list: () => aliases,
    resolve: (shortName) => {
      const normalized = shortName.trim().toLowerCase();
      return aliases.find((entry) => entry.shortName === normalized) ?? null;
    },
  });

export const layerFromOptionalPath = (filePath: string | undefined) =>
  Layer.effect(
    ProjectAliasStore,
    Effect.gen(function* () {
      if (filePath === undefined || filePath.trim().length === 0) {
        yield* Effect.logWarning(
          "T3_PROJECT_ALIASES_PATH is unset; channel topics will not resolve to projects until configured.",
        );
        return makeProjectAliasStore([]);
      }
      const aliases = yield* Effect.try({
        try: () => loadProjectAliasesFromFileSync(filePath),
        catch: (cause) => {
          if (isProjectAliasesLoadError(cause)) return cause;
          return new ProjectAliasesLoadError({
            path: filePath,
            message: cause instanceof Error ? cause.message : String(cause),
          });
        },
      });
      yield* Effect.logInfo(`Loaded ${aliases.length} project alias(es) from ${filePath}`);
      return makeProjectAliasStore(aliases);
    }),
  );
