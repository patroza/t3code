import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export type JiraAuthMode = "basic" | "bearer";

export interface EnabledJiraAppConfig {
  readonly enabled: true;
  readonly webhookSecret: string;
  readonly mention: string;
  readonly baseUrl: string;
  readonly username: string;
  readonly apiToken: string;
  readonly authMode: JiraAuthMode;
  readonly allowedProjects: ReadonlySet<string>;
  readonly discordLinksPath: string | null;
  readonly botAccountId: string | null;
  readonly turnTimeoutMs: number;
  /**
   * When set, unlinked Jira mentions create a new T3 thread on this project
   * (join-or-create) when the Jira project key is not in projectMap.
   * Accepts T3 project id, title, workspace basename, or absolute workspace root.
   * When null and no map hit, auto-create only if the shell has exactly one project.
   */
  readonly defaultProjectId: string | null;
  /**
   * Map Jira project keys (e.g. SA) → T3 project id, title, workspace basename, or
   * absolute workspace root.
   * From `T3CODE_JIRA_PROJECT_MAP=SA:scanner,CFG:/var/lib/t3/src/macs/configurator`.
   */
  readonly projectMap: ReadonlyMap<string, string>;
  /** When false, unlinked issues still get "not yet linked." Default true. */
  readonly autoCreateThread: boolean;
  /**
   * Emoji id for the acknowledgment reaction on the triggering comment (👀 = 1f440).
   * Empty disables reactions. Best-effort — site/API support varies.
   */
  readonly ackEmojiId: string | null;
}

export interface DisabledJiraAppConfig {
  readonly enabled: false;
  readonly missing: ReadonlyArray<string>;
}

export type JiraAppConfigValue = EnabledJiraAppConfig | DisabledJiraAppConfig;

export class JiraAppConfig extends Context.Service<JiraAppConfig, JiraAppConfigValue>()(
  "t3/jira/JiraAppConfig",
) {}

const optionalString = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.getOrUndefined));

const optionalSecret = (name: string) =>
  Config.redacted(name).pipe(
    Config.option,
    Config.map(Option.map(Redacted.value)),
    Config.map(Option.getOrUndefined),
  );

const configEffect = Effect.gen(function* () {
  const values = yield* Config.all({
    webhookSecret: optionalSecret("T3CODE_JIRA_WEBHOOK_SECRET"),
    mention: optionalString("T3CODE_JIRA_MENTION"),
    baseUrl: optionalString("T3CODE_JIRA_URL"),
    legacyBaseUrl: optionalString("JIRA_URL"),
    username: optionalString("T3CODE_JIRA_USERNAME"),
    legacyUsername: optionalString("JIRA_USERNAME"),
    apiToken: optionalSecret("T3CODE_JIRA_API_TOKEN"),
    legacyApiToken: optionalSecret("JIRA_API_TOKEN"),
    authMode: Config.literals(["basic", "bearer"] as const, "T3CODE_JIRA_AUTH_MODE").pipe(
      Config.withDefault("basic" as const),
    ),
    allowedProjects: Config.string("T3CODE_JIRA_ALLOWED_PROJECTS").pipe(Config.withDefault("")),
    discordLinksPath: optionalString("T3CODE_JIRA_DISCORD_LINKS_PATH"),
    botAccountId: optionalString("T3CODE_JIRA_BOT_ACCOUNT_ID"),
    turnTimeoutMs: Config.number("T3CODE_JIRA_TURN_TIMEOUT_MS").pipe(
      Config.withDefault(30 * 60_000),
    ),
    defaultProjectId: optionalString("T3CODE_JIRA_DEFAULT_PROJECT_ID"),
    projectMap: Config.string("T3CODE_JIRA_PROJECT_MAP").pipe(Config.withDefault("")),
    autoCreateThread: Config.boolean("T3CODE_JIRA_AUTO_CREATE_THREAD").pipe(
      Config.withDefault(true),
    ),
    ackEmojiId: optionalString("T3CODE_JIRA_ACK_EMOJI_ID"),
  });

  // Prefer T3CODE_* then fall back to shared MCP-style env names.
  const baseUrl = values.baseUrl?.trim() || values.legacyBaseUrl?.trim();
  const username = values.username?.trim() || values.legacyUsername?.trim();
  const apiToken = values.apiToken?.trim() || values.legacyApiToken?.trim();

  const required = [
    ["T3CODE_JIRA_WEBHOOK_SECRET", values.webhookSecret],
    ["T3CODE_JIRA_MENTION", values.mention],
    ["T3CODE_JIRA_URL (or JIRA_URL)", baseUrl],
    ["T3CODE_JIRA_USERNAME (or JIRA_USERNAME)", username],
    ["T3CODE_JIRA_API_TOKEN (or JIRA_API_TOKEN)", apiToken],
  ] as const;
  const missing = required.filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (missing.length > 0) {
    return JiraAppConfig.of({ enabled: false, missing });
  }

  const allowedProjects = new Set(
    values.allowedProjects
      .split(",")
      .map((project) => project.trim().toUpperCase())
      .filter(Boolean),
  );
  const mention = values.mention!.trim().replace(/^@/u, "");
  const ackEmojiRaw = values.ackEmojiId?.trim();
  // Default 👀 (eyes). Set empty string to disable.
  const ackEmojiId =
    ackEmojiRaw === undefined ? "1f440" : ackEmojiRaw.length === 0 ? null : ackEmojiRaw;
  return JiraAppConfig.of({
    enabled: true,
    webhookSecret: values.webhookSecret!,
    mention,
    baseUrl: baseUrl!.replace(/\/+$/u, ""),
    username: username!,
    apiToken: apiToken!,
    authMode: values.authMode,
    allowedProjects,
    discordLinksPath: values.discordLinksPath?.trim() || null,
    botAccountId: values.botAccountId?.trim() || null,
    turnTimeoutMs: Math.max(10_000, values.turnTimeoutMs),
    defaultProjectId: values.defaultProjectId?.trim() || null,
    projectMap: parseJiraProjectMap(values.projectMap),
    autoCreateThread: values.autoCreateThread,
    ackEmojiId,
  });
});

export const layer = Layer.effect(JiraAppConfig, configEffect);

export function isJiraProjectAllowed(
  allowedProjects: ReadonlySet<string>,
  projectKey: string,
): boolean {
  return allowedProjects.size === 0 || allowedProjects.has(projectKey.trim().toUpperCase());
}

/**
 * Parse `SA:project-id-or-name,CFG:other` (also accepts `=` separators).
 * Keys are uppercased Jira project keys; values are T3 project ids, titles,
 * workspace basenames, or absolute workspace roots (paths after the first `:` / `=`).
 */
export function parseJiraProjectMap(raw: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    // Prefer first : or = (whichever appears first). Paths keep later colons (rare) intact.
    const colon = trimmed.indexOf(":");
    const eq = trimmed.indexOf("=");
    const idx = colon === -1 ? eq : eq === -1 ? colon : Math.min(colon, eq);
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim().toUpperCase();
    const value = trimmed.slice(idx + 1).trim();
    if (key.length === 0 || value.length === 0) continue;
    map.set(key, value);
  }
  return map;
}

export type ShellProjectRef = {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
};

function normalizeWorkspacePath(path: string): string {
  return path.trim().replace(/\/+$/u, "").toLowerCase();
}

function workspaceBasename(path: string): string | undefined {
  const normalized = path.replace(/\/+$/u, "");
  if (normalized.length === 0) return undefined;
  return normalized.split("/").pop()?.toLowerCase();
}

/**
 * Resolve a T3 project id from a configured value:
 * exact project id, project title, absolute workspace root, or workspace basename.
 */
export function resolveMappedT3ProjectId(
  mapped: string,
  shellProjects: ReadonlyArray<ShellProjectRef>,
): string | null {
  const trimmed = mapped.trim();
  if (trimmed.length === 0) return null;
  if (shellProjects.some((project) => project.id === trimmed)) return trimmed;

  const lower = trimmed.toLowerCase();
  const byTitle = shellProjects.find((project) => project.title.trim().toLowerCase() === lower);
  if (byTitle) return byTitle.id;

  const normalizedMapped = normalizeWorkspacePath(trimmed);
  const byRoot = shellProjects.find(
    (project) => normalizeWorkspacePath(project.workspaceRoot) === normalizedMapped,
  );
  if (byRoot) return byRoot.id;

  // Basename-only when the configured value has no path separators (avoid `…/scanner`
  // partially matching a different project whose root ends in `scanner`).
  const looksLikePath = trimmed.includes("/") || trimmed.includes("\\");
  if (!looksLikePath) {
    const byBasename = shellProjects.find(
      (project) => workspaceBasename(project.workspaceRoot) === lower,
    );
    if (byBasename) return byBasename.id;
  }

  return null;
}

/** Look up T3 project for a Jira project key via the configured map. */
export function resolveT3ProjectIdForJiraKey(
  projectMap: ReadonlyMap<string, string>,
  jiraProjectKey: string,
  shellProjects: ReadonlyArray<ShellProjectRef>,
): string | null {
  const mapped = projectMap.get(jiraProjectKey.trim().toUpperCase());
  if (mapped === undefined) return null;
  return resolveMappedT3ProjectId(mapped, shellProjects);
}
