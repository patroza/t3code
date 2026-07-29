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
  });
});

export const layer = Layer.effect(JiraAppConfig, configEffect);

export function isJiraProjectAllowed(
  allowedProjects: ReadonlySet<string>,
  projectKey: string,
): boolean {
  return allowedProjects.size === 0 || allowedProjects.has(projectKey.trim().toUpperCase());
}
