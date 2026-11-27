// @effect-diagnostics nodeBuiltinImport:off -- Effect's Crypto has no RS256 private-key signing.
import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";

const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "t3code-github-app-auth";
const TOKEN_SKEW_MS = 120_000;
const INSTALLATION_TTL_MS = 15 * 60_000;
const APP_SLUG_TTL_MS = 24 * 60 * 60_000;
const DEFAULT_FALLBACK_TOKEN_TTL_MS = 5 * 60_000;

export const DEFAULT_GITHUB_APPS_RELATIVE_PATH = ".config/t3/github-apps.json";

export interface GitHubAppCredentialEntry {
  readonly name?: string | undefined;
  readonly appId: string;
  readonly privateKeyPath: string;
  readonly owners: ReadonlyArray<string>;
  readonly repos: ReadonlyArray<string>;
}

export type GitHubAppRoutingMode = "installed-or-personal" | "app-only";

export type GitHubAppAgentAuthConfig =
  | {
      readonly mode: "disabled";
      readonly agentPolicy: boolean;
    }
  | {
      readonly mode: "apps-file";
      readonly filePath: string;
      readonly apps: ReadonlyArray<GitHubAppCredentialEntry>;
      readonly ownerMap: ReadonlyMap<string, GitHubAppCredentialEntry>;
      readonly repoMap: ReadonlyMap<string, GitHubAppCredentialEntry>;
      readonly agentPolicy: boolean;
    }
  | {
      readonly mode: "apps-file-error";
      readonly filePath: string;
      readonly message: string;
      readonly agentPolicy: boolean;
    }
  | {
      readonly mode: "single-app";
      readonly routing: GitHubAppRoutingMode;
      readonly app: GitHubAppCredentialEntry | null;
      readonly missingReason?: string | undefined;
      readonly agentPolicy: boolean;
    };

export type GitHubAppAccessKind = "read" | "write";

export type GitHubAppRoutingDecision =
  | {
      readonly mode: "app";
      readonly host: string;
      readonly token: Redacted.Redacted<string>;
      readonly fingerprint: string;
      readonly appId: string;
      readonly appName?: string | undefined;
      readonly appSlug: string;
      readonly actor: string;
      readonly installationId: number;
    }
  | {
      readonly mode: "personal";
      readonly configured: boolean;
    };

export class GitHubAppInstallationError extends Schema.TaggedError<GitHubAppInstallationError>()(
  "GitHubAppInstallationError",
  {
    operation: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.NullOr(Schema.Number)),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export class GitHubAppInstallationAuthConfig extends Context.Service<
  GitHubAppInstallationAuthConfig,
  GitHubAppAgentAuthConfig
>()(
  "@t3tools/source-control-github/server/GitHubAppInstallationAuth/GitHubAppInstallationAuthConfig",
) {}

export class GitHubAppInstallationAuth extends Context.Service<
  GitHubAppInstallationAuth,
  {
    readonly config: GitHubAppAgentAuthConfig;
    readonly resolve: (input: {
      readonly host: string;
      readonly repository: string;
      readonly access: GitHubAppAccessKind;
    }) => Effect.Effect<GitHubAppRoutingDecision, GitHubAppInstallationError>;
    readonly invalidate: (input: {
      readonly appId: string;
      readonly host: string;
      readonly repository: string;
    }) => Effect.Effect<void>;
    readonly addIssueAssignees: (input: {
      readonly host: string;
      readonly repository: string;
      readonly number: number;
      readonly assignees: ReadonlyArray<string>;
      readonly token: Redacted.Redacted<string>;
    }) => Effect.Effect<void, GitHubAppInstallationError>;
  }
>()("@t3tools/source-control-github/server/GitHubAppInstallationAuth") {}

export function expandHomePath(rawPath: string, homeDir: string = NodeOS.homedir()): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/")) return NodePath.join(homeDir, trimmed.slice(2));
  return trimmed;
}

const RawAppId = Schema.Union([
  Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  Schema.String,
]);

const RawGitHubAppEntry = Schema.Struct({
  name: Schema.optional(Schema.String),
  appId: RawAppId,
  privateKeyPath: Schema.String,
  owners: Schema.optional(Schema.Array(Schema.String)),
  repos: Schema.optional(Schema.Array(Schema.String)),
});

const RawGitHubAppsFile = Schema.Struct({
  apps: Schema.Array(RawGitHubAppEntry),
});

const decodeRawGitHubAppsFile = Schema.decodeUnknownSync(RawGitHubAppsFile);

export type ParsedGitHubAppsFileResult =
  | {
      readonly ok: true;
      readonly apps: ReadonlyArray<GitHubAppCredentialEntry>;
      readonly ownerMap: ReadonlyMap<string, GitHubAppCredentialEntry>;
      readonly repoMap: ReadonlyMap<string, GitHubAppCredentialEntry>;
    }
  | {
      readonly ok: false;
      readonly message: string;
    };

export function parseGitHubAppsFile(
  rawText: string,
  filePath: string,
  homeDir: string = NodeOS.homedir(),
): ParsedGitHubAppsFileResult {
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      message: `Malformed GitHub Apps config at ${filePath}: ${detail}`,
    };
  }

  let decoded: typeof RawGitHubAppsFile.Type;
  try {
    decoded = decodeRawGitHubAppsFile(json);
  } catch {
    return {
      ok: false,
      message: `Invalid GitHub Apps config at ${filePath}: expected {"apps":[{"appId":...,"privateKeyPath":...,"owners":[...],"repos":[...]}]}.`,
    };
  }

  const apps: Array<GitHubAppCredentialEntry> = [];
  const ownerMap = new Map<string, GitHubAppCredentialEntry>();
  const repoMap = new Map<string, GitHubAppCredentialEntry>();

  for (let index = 0; index < decoded.apps.length; index++) {
    const raw = decoded.apps[index]!;
    const appId = String(raw.appId).trim();
    if (!appId || !/^\d+$/u.test(appId)) {
      return {
        ok: false,
        message: `Invalid GitHub Apps config at ${filePath}: apps[${index}].appId must be a numeric App ID.`,
      };
    }
    const privateKeyPath = expandHomePath(raw.privateKeyPath, homeDir);
    if (!privateKeyPath) {
      return {
        ok: false,
        message: `Invalid GitHub Apps config at ${filePath}: apps[${index}].privateKeyPath must be non-empty.`,
      };
    }
    const name = raw.name?.trim() || undefined;
    const owners: Array<string> = [];
    for (const rawOwner of raw.owners ?? []) {
      const owner = rawOwner.trim();
      if (!owner) {
        return {
          ok: false,
          message: `Invalid GitHub Apps config at ${filePath}: apps[${index}].owners contains an empty owner.`,
        };
      }
      owners.push(owner);
    }

    const repos: Array<string> = [];
    for (const rawRepo of raw.repos ?? []) {
      const parsedRepo = parseOwnerAndRepo(rawRepo);
      if (parsedRepo === null) {
        return {
          ok: false,
          message: `Invalid GitHub Apps config at ${filePath}: apps[${index}].repos contains invalid repository "${rawRepo}" (expected owner/name).`,
        };
      }
      repos.push(parsedRepo.fullName);
    }

    const entry: GitHubAppCredentialEntry = {
      ...(name === undefined ? {} : { name }),
      appId,
      privateKeyPath,
      owners,
      repos,
    };
    apps.push(entry);

    const seenOwners = new Set<string>();
    for (const owner of owners) {
      const key = owner.toLowerCase();
      if (seenOwners.has(key)) continue;
      seenOwners.add(key);
      const existing = ownerMap.get(key);
      if (existing !== undefined) {
        const firstLabel = existing.name ?? `app ${existing.appId}`;
        const secondLabel = entry.name ?? `app ${entry.appId}`;
        return {
          ok: false,
          message: `Duplicate GitHub owner "${owner}" in ${filePath}: mapped to both ${firstLabel} and ${secondLabel}.`,
        };
      }
      ownerMap.set(key, entry);
    }

    const seenRepos = new Set<string>();
    for (const repo of repos) {
      const key = repo.toLowerCase();
      if (seenRepos.has(key)) continue;
      seenRepos.add(key);
      const existing = repoMap.get(key);
      if (existing !== undefined) {
        const firstLabel = existing.name ?? `app ${existing.appId}`;
        const secondLabel = entry.name ?? `app ${entry.appId}`;
        return {
          ok: false,
          message: `Duplicate GitHub repository "${repo}" in ${filePath}: mapped to both ${firstLabel} and ${secondLabel}.`,
        };
      }
      repoMap.set(key, entry);
    }
  }

  return { ok: true, apps, ownerMap, repoMap };
}

export const loadGitHubAppAgentAuthConfig = Effect.fn("GitHubAppInstallationAuth.loadConfig")(
  function* (input: {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly homeDir?: string;
    readonly fileSystem: FileSystem.FileSystem;
  }): Effect.fn.Return<GitHubAppAgentAuthConfig> {
    const env = input.env;
    const homeDir = input.homeDir ?? NodeOS.homedir();
    const authFlag = env.T3_GITHUB_APP_AUTH?.trim().toLowerCase();
    const authExplicitlyOff = authFlag === "0" || authFlag === "false";
    const authOn = authFlag === "1" || authFlag === "true";
    const routingRaw = env.T3_GITHUB_APP_ROUTING?.trim().toLowerCase();
    const agentPolicy =
      env.T3_GITHUB_APP_AGENT_POLICY?.trim() === "1" || routingRaw === "installed-or-personal";

    if (authExplicitlyOff) {
      return { mode: "disabled", agentPolicy } satisfies GitHubAppAgentAuthConfig;
    }

    const explicitFile = env.T3_GITHUB_APPS_FILE?.trim();
    const candidateFile = explicitFile
      ? expandHomePath(explicitFile, homeDir)
      : authOn
        ? NodePath.join(homeDir, DEFAULT_GITHUB_APPS_RELATIVE_PATH)
        : undefined;

    if (candidateFile !== undefined) {
      const exists = yield* input.fileSystem
        .exists(candidateFile)
        .pipe(Effect.orElseSucceed(() => false));
      if (exists) {
        const read = yield* input.fileSystem.readFileString(candidateFile).pipe(Effect.result);
        if (read._tag === "Failure") {
          return {
            mode: "apps-file-error",
            filePath: candidateFile,
            message: `Could not read GitHub Apps config at ${candidateFile}.`,
            agentPolicy,
          } satisfies GitHubAppAgentAuthConfig;
        }
        const parsed = parseGitHubAppsFile(read.success, candidateFile, homeDir);
        if (!parsed.ok) {
          return {
            mode: "apps-file-error",
            filePath: candidateFile,
            message: parsed.message,
            agentPolicy,
          } satisfies GitHubAppAgentAuthConfig;
        }
        return {
          mode: "apps-file",
          filePath: candidateFile,
          apps: parsed.apps,
          ownerMap: parsed.ownerMap,
          repoMap: parsed.repoMap,
          agentPolicy,
        } satisfies GitHubAppAgentAuthConfig;
      }
    }

    const appId = env.T3CODE_GITHUB_APP_ID?.trim();
    const keyPathRaw = env.T3CODE_GITHUB_APP_PRIVATE_KEY_PATH?.trim();
    const keyPath = keyPathRaw ? expandHomePath(keyPathRaw, homeDir) : undefined;

    if (authOn || (explicitFile !== undefined && Boolean(appId && keyPath))) {
      const routing: GitHubAppRoutingMode =
        routingRaw === "installed-or-personal" || (explicitFile !== undefined && !routingRaw)
          ? "installed-or-personal"
          : "app-only";
      if (appId && keyPath) {
        return {
          mode: "single-app",
          routing,
          app: { appId, privateKeyPath: keyPath, owners: [], repos: [] },
          agentPolicy,
        } satisfies GitHubAppAgentAuthConfig;
      }
      return {
        mode: "single-app",
        routing,
        app: null,
        missingReason:
          "GitHub App auth is enabled (T3_GITHUB_APP_AUTH=1) but T3CODE_GITHUB_APP_ID or T3CODE_GITHUB_APP_PRIVATE_KEY_PATH is missing.",
        agentPolicy,
      } satisfies GitHubAppAgentAuthConfig;
    }

    return { mode: "disabled", agentPolicy } satisfies GitHubAppAgentAuthConfig;
  },
);

export function createGitHubAppJwt(input: {
  readonly appId: string;
  readonly privateKey: string;
  readonly nowSeconds: number;
}): string {
  const encode = (value: unknown) =>
    NodeBuffer.Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iat: input.nowSeconds - 60,
    exp: input.nowSeconds + 9 * 60,
    iss: input.appId,
  });
  const unsigned = `${header}.${payload}`;
  const signature = NodeCrypto.sign(
    "RSA-SHA256",
    NodeBuffer.Buffer.from(unsigned),
    input.privateKey,
  ).toString("base64url");
  return `${unsigned}.${signature}`;
}

export function parseOwnerAndRepo(
  repository: string,
): { readonly owner: string; readonly name: string; readonly fullName: string } | null {
  const trimmed = repository
    .trim()
    .replace(/\.git\/?$/iu, "")
    .replace(/^\/+|\/+$/gu, "");
  const parts = trimmed.split("/").filter(Boolean);
  const pair = parts.length >= 3 ? parts.slice(-2) : parts;
  if (pair.length !== 2) return null;
  const [owner, name] = pair;
  if (!owner || !name || /\s/u.test(owner) || /\s/u.test(name)) return null;
  return { owner, name, fullName: `${owner}/${name}` };
}

export function isGitHubHostName(host: string): boolean {
  const normalized = normalizeHost(host);
  return normalized === "github.com" || normalized.endsWith(".ghe.com");
}

function tokenFingerprint(host: string, appId: string, token: string): string {
  const hash = NodeCrypto.createHash("sha256").update(token).digest("hex");
  return `${host}:app:${appId}:${hash}`;
}

const InstallationLookupResponse = Schema.Struct({
  id: Schema.Finite,
});

const AppMetadataResponse = Schema.Struct({
  slug: Schema.String,
});

const InstallationTokenResponse = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.optional(Schema.String),
});

const DEFAULT_TOKEN_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  metadata: "read",
  checks: "read",
  statuses: "read",
  actions: "write",
  workflows: "write",
} as const;

interface CachedToken {
  readonly token: Redacted.Redacted<string>;
  readonly fingerprint: string;
  readonly expiresAtMs: number;
  readonly installationId: number;
  readonly appSlug: string;
  readonly actor: string;
}

interface CachedInstallation {
  readonly installationId: number;
  readonly expiresAtMs: number;
}

interface CachedAppSlug {
  readonly slug: string;
  readonly expiresAtMs: number;
}

type InstallationLookupResult =
  | { readonly status: "installed"; readonly installationId: number }
  | { readonly status: "not-installed" };

function appLabel(app: GitHubAppCredentialEntry): string {
  return app.name ? `${app.name} (App ${app.appId})` : `GitHub App ${app.appId}`;
}

export const make = Effect.gen(function* () {
  const config = yield* GitHubAppInstallationAuthConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;

  const tokenCache = yield* Ref.make(new Map<string, CachedToken>());
  const installationCache = yield* Ref.make(new Map<string, CachedInstallation>());
  const appSlugCache = yield* Ref.make(new Map<string, CachedAppSlug>());
  const locks = new Map<string, Semaphore.Semaphore>();

  const withKeyLock = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) => {
    let lock = locks.get(key);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(key, lock);
    }
    return lock.withPermit(effect);
  };

  const executeRaw = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    { readonly status: number; readonly body: string },
    GitHubAppInstallationError
  > =>
    httpClient
      .execute(
        request.pipe(
          HttpClientRequest.setHeaders({
            accept: "application/vnd.github+json",
            "x-github-api-version": GITHUB_API_VERSION,
            "user-agent": USER_AGENT,
          }),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new GitHubAppInstallationError({
              operation,
              status: null,
              detail: `GitHub App API request failed during ${operation}.`,
              cause,
            }),
        ),
        Effect.flatMap((response: HttpClientResponse.HttpClientResponse) =>
          response.text.pipe(
            Effect.orElseSucceed(() => ""),
            Effect.map((body) => ({ status: response.status, body })),
          ),
        ),
        Effect.scoped,
      );

  const decodeJson = <S extends Schema.Top>(
    operation: string,
    status: number,
    body: string,
    schema: S,
  ): Effect.Effect<S["Type"], GitHubAppInstallationError, S["DecodingServices"]> =>
    Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubAppInstallationError({
            operation,
            status,
            detail: `GitHub App API returned an unexpected response during ${operation}.`,
            cause,
          }),
      ),
    );

  const signAppJwt = Effect.fn("GitHubAppInstallationAuth.signAppJwt")(function* (
    app: GitHubAppCredentialEntry,
  ) {
    const privateKey = yield* fileSystem.readFileString(app.privateKeyPath).pipe(
      Effect.mapError(
        (cause) =>
          new GitHubAppInstallationError({
            operation: "read-private-key",
            status: null,
            detail: `Could not read private key for ${appLabel(app)} at ${app.privateKeyPath}.`,
            cause,
          }),
      ),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    return yield* Effect.try({
      try: () =>
        createGitHubAppJwt({
          appId: app.appId,
          privateKey,
          nowSeconds: Math.floor(nowMs / 1_000),
        }),
      catch: (cause) =>
        new GitHubAppInstallationError({
          operation: "sign-app-jwt",
          status: null,
          detail: `Could not sign JWT for ${appLabel(app)}; check the private key PEM.`,
          cause,
        }),
    });
  });

  const resolveAppSlug = Effect.fn("GitHubAppInstallationAuth.resolveAppSlug")(function* (
    app: GitHubAppCredentialEntry,
    host: string,
    jwt: string,
  ) {
    const key = `${app.appId}\0${host}`;
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(appSlugCache)).get(key);
    if (cached !== undefined && cached.expiresAtMs > nowMs) return cached.slug;

    const restUrl = GitHubRequestPolicy.gitHubApiUrls(host).rest;
    const slug = yield* executeRaw(
      "lookup-app",
      HttpClientRequest.get(`${restUrl}/app`).pipe(HttpClientRequest.bearerToken(jwt)),
    ).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? decodeJson("lookup-app", res.status, res.body, AppMetadataResponse).pipe(
              Effect.map((meta) => meta.slug),
            )
          : Effect.succeed(app.name ?? `app-${app.appId}`),
      ),
      Effect.orElseSucceed(() => app.name ?? `app-${app.appId}`),
    );

    yield* Ref.update(appSlugCache, (map) => {
      const next = new Map(map);
      next.set(key, { slug, expiresAtMs: nowMs + APP_SLUG_TTL_MS });
      return next;
    });
    return slug;
  });

  const lookupInstallation = Effect.fn("GitHubAppInstallationAuth.lookupInstallation")(function* (
    app: GitHubAppCredentialEntry,
    host: string,
    repo: { readonly owner: string; readonly name: string; readonly fullName: string },
    jwt: string,
  ): Effect.fn.Return<InstallationLookupResult, GitHubAppInstallationError> {
    const key = `${app.appId}\0${host}\0${repo.fullName.toLowerCase()}`;
    const nowMs = yield* Clock.currentTimeMillis;
    const cached = (yield* Ref.get(installationCache)).get(key);
    if (cached !== undefined && cached.expiresAtMs > nowMs) {
      return { status: "installed", installationId: cached.installationId };
    }

    const restUrl = GitHubRequestPolicy.gitHubApiUrls(host).rest;
    const response = yield* executeRaw(
      "lookup-installation",
      HttpClientRequest.get(
        `${restUrl}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/installation`,
      ).pipe(HttpClientRequest.bearerToken(jwt)),
    );

    if (response.status === 404) {
      return { status: "not-installed" };
    }
    if (response.status !== 200) {
      return yield* new GitHubAppInstallationError({
        operation: "lookup-installation",
        status: response.status,
        detail: `Installation lookup failed for ${appLabel(app)} on ${repo.fullName} (HTTP ${response.status}).`,
      });
    }
    const decoded = yield* decodeJson(
      "lookup-installation",
      response.status,
      response.body,
      InstallationLookupResponse,
    );
    yield* Ref.update(installationCache, (map) => {
      const next = new Map(map);
      next.set(key, {
        installationId: decoded.id,
        expiresAtMs: nowMs + INSTALLATION_TTL_MS,
      });
      return next;
    });
    return { status: "installed", installationId: decoded.id };
  });

  const mintAccessToken = Effect.fn("GitHubAppInstallationAuth.mintAccessToken")(function* (
    app: GitHubAppCredentialEntry,
    host: string,
    installationId: number,
    repo: { readonly owner: string; readonly name: string; readonly fullName: string },
    jwt: string,
  ) {
    const restUrl = GitHubRequestPolicy.gitHubApiUrls(host).rest;
    const url = `${restUrl}/app/installations/${encodeURIComponent(String(installationId))}/access_tokens`;

    const postMint = (body: Record<string, unknown>) =>
      executeRaw(
        "mint-installation-token",
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bearerToken(jwt),
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      );

    let response = yield* postMint({
      permissions: DEFAULT_TOKEN_PERMISSIONS,
      repositories: [repo.name],
    });

    if (response.status === 422 && /permission/iu.test(response.body)) {
      const { workflows: _drop, ...withoutWorkflows } = DEFAULT_TOKEN_PERMISSIONS;
      response = yield* postMint({
        permissions: withoutWorkflows,
        repositories: [repo.name],
      });
    }

    if (response.status === 422 && /permission/iu.test(response.body)) {
      response = yield* postMint({ repositories: [repo.name] });
    }

    if (response.status !== 201 && response.status !== 200) {
      return yield* new GitHubAppInstallationError({
        operation: "mint-installation-token",
        status: response.status,
        detail: `Failed to mint GitHub App installation token for ${appLabel(app)} on ${repo.fullName} (HTTP ${response.status}).`,
      });
    }

    const decoded = yield* decodeJson(
      "mint-installation-token",
      response.status,
      response.body,
      InstallationTokenResponse,
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const parsedExpiry = decoded.expires_at ? Date.parse(decoded.expires_at) : Number.NaN;
    const expiresAtMs = Number.isFinite(parsedExpiry)
      ? parsedExpiry
      : nowMs + DEFAULT_FALLBACK_TOKEN_TTL_MS;

    return {
      token: Redacted.make(decoded.token),
      fingerprint: tokenFingerprint(host, app.appId, decoded.token),
      expiresAtMs,
    };
  });

  const resolveForApp = Effect.fn("GitHubAppInstallationAuth.resolveForApp")(function* (input: {
    readonly app: GitHubAppCredentialEntry;
    readonly host: string;
    readonly repo: { readonly owner: string; readonly name: string; readonly fullName: string };
    readonly treatNotInstalledAsPersonal: boolean;
  }): Effect.fn.Return<GitHubAppRoutingDecision, GitHubAppInstallationError> {
    const cacheKey = `${input.app.appId}\0${input.host}\0${input.repo.fullName.toLowerCase()}`;
    const checkFresh = Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const cached = (yield* Ref.get(tokenCache)).get(cacheKey);
      if (cached !== undefined && cached.expiresAtMs - nowMs > TOKEN_SKEW_MS) {
        return {
          mode: "app" as const,
          host: input.host,
          token: cached.token,
          fingerprint: cached.fingerprint,
          appId: input.app.appId,
          ...(input.app.name === undefined ? {} : { appName: input.app.name }),
          appSlug: cached.appSlug,
          actor: cached.actor,
          installationId: cached.installationId,
        };
      }
      return null;
    });

    const hit = yield* checkFresh;
    if (hit !== null) return hit;

    return yield* withKeyLock(
      cacheKey,
      Effect.gen(function* () {
        const hitAfterLock = yield* checkFresh;
        if (hitAfterLock !== null) return hitAfterLock;

        const jwt = yield* signAppJwt(input.app);
        const lookup = yield* lookupInstallation(input.app, input.host, input.repo, jwt);
        if (lookup.status === "not-installed") {
          if (input.treatNotInstalledAsPersonal) {
            return { mode: "personal" as const, configured: true };
          }
          return yield* new GitHubAppInstallationError({
            operation: "lookup-installation",
            status: 404,
            detail: `${appLabel(input.app)} is not installed on ${input.repo.fullName}; refusing to fall back to personal account.`,
          });
        }

        const minted = yield* mintAccessToken(
          input.app,
          input.host,
          lookup.installationId,
          input.repo,
          jwt,
        );
        const appSlug = yield* resolveAppSlug(input.app, input.host, jwt);
        const actor = `${appSlug}[bot]`;

        yield* Ref.update(tokenCache, (map) => {
          const next = new Map(map);
          next.set(cacheKey, {
            token: minted.token,
            fingerprint: minted.fingerprint,
            expiresAtMs: minted.expiresAtMs,
            installationId: lookup.installationId,
            appSlug,
            actor,
          });
          return next;
        });

        return {
          mode: "app" as const,
          host: input.host,
          token: minted.token,
          fingerprint: minted.fingerprint,
          appId: input.app.appId,
          ...(input.app.name === undefined ? {} : { appName: input.app.name }),
          appSlug,
          actor,
          installationId: lookup.installationId,
        };
      }),
    );
  });

  const resolve: GitHubAppInstallationAuth["Service"]["resolve"] = Effect.fn(
    "GitHubAppInstallationAuth.resolve",
  )(function* (input) {
    const host = normalizeHost(input.host);
    if (!isGitHubHostName(host)) {
      return { mode: "personal" as const, configured: false };
    }
    if (config.mode === "disabled") {
      return { mode: "personal" as const, configured: false };
    }

    if (config.mode === "apps-file-error") {
      if (input.access === "read") {
        yield* Effect.logWarning("GitHub Apps config invalid; falling back to personal for read", {
          filePath: config.filePath,
          reason: config.message,
        });
        return { mode: "personal" as const, configured: true };
      }
      return yield* new GitHubAppInstallationError({
        operation: "config",
        status: null,
        detail: `${config.message} Refusing to fall back to personal account for write.`,
      });
    }

    const repo = parseOwnerAndRepo(input.repository);
    if (repo === null) {
      if (input.access === "read") {
        return { mode: "personal" as const, configured: true };
      }
      return yield* new GitHubAppInstallationError({
        operation: "resolve-repository",
        status: null,
        detail: `Cannot parse GitHub repository "${input.repository}" (expected owner/name); refusing to fall back to personal account.`,
      });
    }

    if (config.mode === "apps-file") {
      const mappedApp =
        config.repoMap.get(repo.fullName.toLowerCase()) ??
        config.ownerMap.get(repo.owner.toLowerCase());
      if (mappedApp === undefined) {
        return { mode: "personal" as const, configured: true };
      }
      return yield* resolveForApp({
        app: mappedApp,
        host,
        repo,
        treatNotInstalledAsPersonal: false,
      }).pipe(
        Effect.catch((error) => {
          if (input.access === "read") {
            return Effect.logWarning(
              "GitHub App token unavailable for read; falling back to personal",
              {
                appId: mappedApp.appId,
                repository: repo.fullName,
                operation: error.operation,
              },
            ).pipe(Effect.as({ mode: "personal" as const, configured: true }));
          }
          return Effect.fail(error);
        }),
      );
    }

    // Backward-compatible single-app mode when apps file is absent and T3_GITHUB_APP_AUTH=1.
    if (config.app === null) {
      const detail =
        config.missingReason ??
        "GitHub App auth is enabled but App ID or private key path is missing.";
      if (input.access === "read" && config.routing === "installed-or-personal") {
        yield* Effect.logWarning("GitHub App config incomplete; falling back to personal for read");
        return { mode: "personal" as const, configured: true };
      }
      return yield* new GitHubAppInstallationError({
        operation: "config",
        status: null,
        detail: `${detail} Refusing to fall back to personal account.`,
      });
    }

    return yield* resolveForApp({
      app: config.app,
      host,
      repo,
      treatNotInstalledAsPersonal: config.routing === "installed-or-personal",
    }).pipe(
      Effect.catch((error) => {
        if (input.access === "read" && config.routing === "installed-or-personal") {
          return Effect.logWarning(
            "GitHub App token unavailable for read; falling back to personal",
            {
              appId: config.app!.appId,
              repository: repo.fullName,
              operation: error.operation,
            },
          ).pipe(Effect.as({ mode: "personal" as const, configured: true }));
        }
        return Effect.fail(error);
      }),
    );
  });

  const invalidate: GitHubAppInstallationAuth["Service"]["invalidate"] = Effect.fn(
    "GitHubAppInstallationAuth.invalidate",
  )(function* (input) {
    const host = normalizeHost(input.host);
    const repo = parseOwnerAndRepo(input.repository);
    if (repo === null) return;
    const key = `${input.appId}\0${host}\0${repo.fullName.toLowerCase()}`;
    yield* Ref.update(tokenCache, (map) => {
      const next = new Map(map);
      next.delete(key);
      return next;
    });
    yield* Ref.update(installationCache, (map) => {
      const next = new Map(map);
      next.delete(key);
      return next;
    });
  });

  const addIssueAssignees: GitHubAppInstallationAuth["Service"]["addIssueAssignees"] = Effect.fn(
    "GitHubAppInstallationAuth.addIssueAssignees",
  )(function* (input) {
    if (input.assignees.length === 0) return;
    const host = normalizeHost(input.host);
    const repo = parseOwnerAndRepo(input.repository);
    if (repo === null) return;
    const restUrl = GitHubRequestPolicy.gitHubApiUrls(host).rest;
    const response = yield* executeRaw(
      "add-assignees",
      HttpClientRequest.post(
        `${restUrl}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}/issues/${input.number}/assignees`,
      ).pipe(
        HttpClientRequest.bearerToken(Redacted.value(input.token)),
        HttpClientRequest.bodyJsonUnsafe({ assignees: [...input.assignees] }),
      ),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new GitHubAppInstallationError({
        operation: "add-assignees",
        status: response.status,
        detail: `Could not assign ${input.assignees.join(", ")} on ${repo.fullName}#${input.number} (HTTP ${response.status}).`,
      });
    }
  });

  return GitHubAppInstallationAuth.of({
    config,
    resolve,
    invalidate,
    addIssueAssignees,
  });
});

export const layer = Layer.effect(GitHubAppInstallationAuth, make);

export const PinnedGitHubCredential = GitHubRequestPolicy.PinnedGitHubCredential;
