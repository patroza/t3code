import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

export type GitHubRepositoryPermission = "read" | "triage" | "write" | "maintain" | "admin";

export interface EnabledGitHubAppConfig {
  readonly enabled: true;
  readonly appId: string;
  readonly privateKeyPath: string;
  readonly webhookSecret: string;
  readonly mention: string;
  readonly allowedRepositories: ReadonlySet<string>;
  readonly minimumPermission: GitHubRepositoryPermission;
  readonly turnTimeoutMs: number;
}

export interface DisabledGitHubAppConfig {
  readonly enabled: false;
  readonly missing: ReadonlyArray<string>;
}

export type GitHubAppConfigValue = EnabledGitHubAppConfig | DisabledGitHubAppConfig;

export class GitHubAppConfig extends Context.Service<GitHubAppConfig, GitHubAppConfigValue>()(
  "t3/github/GitHubAppConfig",
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
    appId: optionalString("T3CODE_GITHUB_APP_ID"),
    privateKeyPath: optionalString("T3CODE_GITHUB_APP_PRIVATE_KEY_PATH"),
    webhookSecret: optionalSecret("T3CODE_GITHUB_WEBHOOK_SECRET"),
    mention: optionalString("T3CODE_GITHUB_APP_MENTION"),
    allowedRepositories: Config.string("T3CODE_GITHUB_ALLOWED_REPOSITORIES").pipe(
      Config.withDefault(""),
    ),
    minimumPermission: Config.literals(
      ["read", "triage", "write", "maintain", "admin"] as const,
      "T3CODE_GITHUB_MIN_PERMISSION",
    ).pipe(Config.withDefault("write" as const)),
    turnTimeoutMs: Config.number("T3CODE_GITHUB_TURN_TIMEOUT_MS").pipe(
      Config.withDefault(30 * 60_000),
    ),
  });

  const required = [
    ["T3CODE_GITHUB_APP_ID", values.appId],
    ["T3CODE_GITHUB_APP_PRIVATE_KEY_PATH", values.privateKeyPath],
    ["T3CODE_GITHUB_WEBHOOK_SECRET", values.webhookSecret],
    ["T3CODE_GITHUB_APP_MENTION", values.mention],
  ] as const;
  const missing = required.filter(([, value]) => !value?.trim()).map(([name]) => name);
  if (missing.length > 0) {
    return GitHubAppConfig.of({ enabled: false, missing });
  }

  const allowedRepositories = new Set(
    values.allowedRepositories
      .split(",")
      .map((repository) => repository.trim().toLowerCase())
      .filter(Boolean),
  );
  const mention = values.mention!.trim().replace(/^@/u, "");
  return GitHubAppConfig.of({
    enabled: true,
    appId: values.appId!.trim(),
    privateKeyPath: values.privateKeyPath!.trim(),
    webhookSecret: values.webhookSecret!,
    mention,
    allowedRepositories,
    minimumPermission: values.minimumPermission,
    turnTimeoutMs: Math.max(10_000, values.turnTimeoutMs),
  });
});

export const layer = Layer.effect(GitHubAppConfig, configEffect);
