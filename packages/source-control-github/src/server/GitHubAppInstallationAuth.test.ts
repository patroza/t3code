// @effect-diagnostics nodeBuiltinImport:off -- RSA keypair generation for offline unit tests.
import * as NodeCrypto from "node:crypto";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";

import {
  GitHubAppInstallationAuth,
  GitHubAppInstallationAuthConfig,
  expandHomePath,
  layer as installationAuthLayer,
  loadGitHubAppAgentAuthConfig,
  parseGitHubAppsFile,
  type GitHubAppAgentAuthConfig,
} from "./GitHubAppInstallationAuth.ts";

const TEST_KEY_A = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const TEST_KEY_B = NodeCrypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

function fakeFileSystem(files: Readonly<Record<string, string>>): FileSystem.FileSystem {
  return FileSystem.makeNoop({
    exists: (path) => Effect.succeed(Object.prototype.hasOwnProperty.call(files, path)),
    readFileString: (path) =>
      Object.prototype.hasOwnProperty.call(files, path)
        ? Effect.succeed(files[path]!)
        : Effect.fail({ _tag: "SystemError", message: `ENOENT: ${path}` } as never),
  });
}

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authHeader: string | undefined;
  readonly body: unknown;
}

function makeFakeHttp(
  handler: (req: RecordedRequest) => { readonly status: number; readonly body: unknown },
) {
  const calls: Array<RecordedRequest> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      let body: unknown = undefined;
      if (request.body._tag === "Uint8Array") {
        const text = new TextDecoder().decode(request.body.body);
        try {
          body = JSON.parse(text);
        } catch {
          body = text;
        }
      }
      const recorded: RecordedRequest = {
        method: request.method,
        url: request.url,
        authHeader: request.headers.authorization,
        body,
      };
      calls.push(recorded);
      const reply = handler(recorded);
      const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {});
      return HttpClientResponse.fromWeb(
        request,
        new Response(text, {
          status: reply.status,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  );
  return { calls, layer: Layer.succeed(HttpClient.HttpClient, client) };
}

function jwtIssuer(authHeader: string | undefined): string | null {
  const token = authHeader?.replace(/^Bearer\s+/iu, "");
  const parts = token?.split(".");
  if (!parts || parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      iss?: string;
    };
    return payload.iss ?? null;
  } catch {
    return null;
  }
}

function provideAuth(
  config: GitHubAppAgentAuthConfig,
  files: Readonly<Record<string, string>>,
  httpLayer: Layer.Layer<HttpClient.HttpClient>,
) {
  return installationAuthLayer.pipe(
    Layer.provide(Layer.succeed(GitHubAppInstallationAuthConfig, config)),
    Layer.provide(Layer.succeed(FileSystem.FileSystem, fakeFileSystem(files))),
    Layer.provide(httpLayer),
  );
}

describe("GitHubAppInstallationAuth config parsing", () => {
  it("expands ~ in paths and ignores unknown extra fields", () => {
    expect(expandHomePath("~/.config/t3/key.pem", "/home/alice")).toBe(
      "/home/alice/.config/t3/key.pem",
    );
    const parsed = parseGitHubAppsFile(
      JSON.stringify({
        version: 1,
        extraRoot: true,
        apps: [
          {
            name: "omegent-app",
            appId: 4331997,
            privateKeyPath: "~/.config/t3/github-app/private-key.pem",
            owners: ["macs-holding", "aaaomega"],
            extraField: "ignored",
          },
          {
            name: "scrapline-multica",
            appId: "5677773",
            privateKeyPath: "/etc/keys/scrapline.pem",
            owners: ["scrapline-hq"],
          },
        ],
      }),
      "/home/alice/.config/t3/github-apps.json",
      "/home/alice",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.apps).toHaveLength(2);
    expect(parsed.ownerMap.get("macs-holding")?.appId).toBe("4331997");
    expect(parsed.ownerMap.get("macs-holding")?.privateKeyPath).toBe(
      "/home/alice/.config/t3/github-app/private-key.pem",
    );
    expect(parsed.ownerMap.get("scrapline-hq")?.appId).toBe("5677773");
  });

  it("rejects duplicate owners across apps (case-insensitive)", () => {
    const parsed = parseGitHubAppsFile(
      JSON.stringify({
        apps: [
          { name: "app-a", appId: 111, privateKeyPath: "/a.pem", owners: ["Acme"] },
          { name: "app-b", appId: 222, privateKeyPath: "/b.pem", owners: ["acme"] },
        ],
      }),
      "/tmp/apps.json",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("Duplicate GitHub owner");
  });

  it("rejects duplicate repos across apps (case-insensitive)", () => {
    const parsed = parseGitHubAppsFile(
      JSON.stringify({
        apps: [
          {
            name: "app-a",
            appId: 111,
            privateKeyPath: "/a.pem",
            owners: [],
            repos: ["patroza/effect-ui-ssr-lazy-routes"],
          },
          {
            name: "app-b",
            appId: 222,
            privateKeyPath: "/b.pem",
            owners: [],
            repos: ["PATROZA/Effect-UI-SSR-Lazy-Routes"],
          },
        ],
      }),
      "/tmp/apps.json",
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("Duplicate GitHub repository");
  });

  it("rejects malformed JSON", () => {
    const parsed = parseGitHubAppsFile("{ not json", "/tmp/apps.json");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.message).toContain("Malformed GitHub Apps config");
  });

  it.effect(
    "prefers apps file over single-app env when file is present, falls back when absent",
    () =>
      Effect.gen(function* () {
        const files = {
          "/home/pat/.config/t3/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "~/.config/t3/a.pem",
                owners: ["macs-holding"],
              },
            ],
          }),
        };
        const fromFile = yield* loadGitHubAppAgentAuthConfig({
          env: {
            T3_GITHUB_APP_AUTH: "1",
            T3_GITHUB_APP_AGENT_POLICY: "1",
            T3CODE_GITHUB_APP_ID: "9999",
            T3CODE_GITHUB_APP_PRIVATE_KEY_PATH: "/other.pem",
          },
          homeDir: "/home/pat",
          fileSystem: fakeFileSystem(files),
        });
        expect(fromFile.mode).toBe("apps-file");
        expect(fromFile.agentPolicy).toBe(true);

        const fallback = yield* loadGitHubAppAgentAuthConfig({
          env: {
            T3_GITHUB_APP_AUTH: "1",
            T3_GITHUB_APP_ROUTING: "installed-or-personal",
            T3CODE_GITHUB_APP_ID: "4331997",
            T3CODE_GITHUB_APP_PRIVATE_KEY_PATH: "~/.config/t3/a.pem",
          },
          homeDir: "/home/pat",
          fileSystem: fakeFileSystem({}),
        });
        expect(fallback.mode).toBe("single-app");
        if (fallback.mode === "single-app") {
          expect(fallback.routing).toBe("installed-or-personal");
          expect(fallback.app?.appId).toBe("4331997");
          expect(fallback.app?.privateKeyPath).toBe("/home/pat/.config/t3/a.pem");
        }

        const disabled = yield* loadGitHubAppAgentAuthConfig({
          env: {},
          homeDir: "/home/pat",
          fileSystem: fakeFileSystem(files),
        });
        expect(disabled.mode).toBe("disabled");
        expect(disabled.agentPolicy).toBe(false);
      }),
  );
});

describe("GitHubAppInstallationAuth routing, caching, and failures", () => {
  it.effect(
    "routes multiple apps by owner (case-insensitive) and leaves unlisted owners personal",
    () =>
      Effect.gen(function* () {
        const files = {
          "/keys/omegent.pem": TEST_KEY_A,
          "/keys/scrapline.pem": TEST_KEY_B,
          "/etc/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "/keys/omegent.pem",
                owners: ["macs-holding", "aaaomega"],
              },
              {
                name: "scrapline-multica",
                appId: 5677773,
                privateKeyPath: "/keys/scrapline.pem",
                owners: ["scrapline-hq"],
              },
            ],
          }),
        };
        const config = yield* loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json", T3_GITHUB_APP_AGENT_POLICY: "1" },
          fileSystem: fakeFileSystem(files),
        });
        const http = makeFakeHttp((req) => {
          const iss = jwtIssuer(req.authHeader);
          if (req.url.endsWith("/repos/macs-holding/shop/installation")) {
            return { status: 200, body: { id: 101 } };
          }
          if (req.url.endsWith("/repos/SCRAPLINE-HQ/scrapline/installation")) {
            return { status: 200, body: { id: 202 } };
          }
          if (req.url.endsWith("/app/installations/101/access_tokens")) {
            return {
              status: 201,
              body: { token: `tok-${iss}-101`, expires_at: "2099-01-01T01:00:00Z" },
            };
          }
          if (req.url.endsWith("/app/installations/202/access_tokens")) {
            return {
              status: 201,
              body: { token: `tok-${iss}-202`, expires_at: "2099-01-01T01:00:00Z" },
            };
          }
          if (req.url.endsWith("/app")) {
            return {
              status: 200,
              body: { slug: iss === "4331997" ? "omegent-app" : "scrapline-multica" },
            };
          }
          return { status: 404, body: { message: "Not Found" } };
        });

        const layer = provideAuth(config, files, http.layer);
        const result = yield* Effect.gen(function* () {
          const auth = yield* GitHubAppInstallationAuth;
          const work = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
          });
          const priv = yield* auth.resolve({
            host: "github.com",
            repository: "SCRAPLINE-HQ/scrapline",
            access: "write",
          });
          const personal = yield* auth.resolve({
            host: "github.com",
            repository: "patroza/t3code",
            access: "write",
          });
          return { work, priv, personal };
        }).pipe(Effect.provide(layer));

        expect(result.work.mode).toBe("app");
        if (result.work.mode === "app") {
          expect(result.work.appId).toBe("4331997");
          expect(result.work.actor).toBe("omegent-app[bot]");
          expect(Redacted.value(result.work.token)).toBe("tok-4331997-101");
        }

        expect(result.priv.mode).toBe("app");
        if (result.priv.mode === "app") {
          expect(result.priv.appId).toBe("5677773");
          expect(result.priv.actor).toBe("scrapline-multica[bot]");
          expect(Redacted.value(result.priv.token)).toBe("tok-5677773-202");
        }

        expect(result.personal).toEqual({ mode: "personal", configured: true });
      }),
  );

  it.effect(
    "fails writes closed for listed owners on 404, missing key, or mint error; reads fall back",
    () =>
      Effect.gen(function* () {
        const files = {
          "/keys/omegent.pem": TEST_KEY_A,
          "/etc/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "/keys/omegent.pem",
                owners: ["macs-holding"],
              },
              {
                name: "scrapline-multica",
                appId: 5677773,
                privateKeyPath: "/keys/missing.pem",
                owners: ["scrapline-hq"],
              },
            ],
          }),
        };
        const config = yield* loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json" },
          fileSystem: fakeFileSystem(files),
        });
        const http = makeFakeHttp((req) => {
          if (req.url.endsWith("/repos/macs-holding/uninstalled/installation")) {
            return { status: 404, body: { message: "Not Found" } };
          }
          if (req.url.endsWith("/repos/macs-holding/mint-fail/installation")) {
            return { status: 200, body: { id: 303 } };
          }
          return { status: 500, body: { message: "boom" } };
        });

        const layer = provideAuth(config, files, http.layer);
        yield* Effect.gen(function* () {
          const auth = yield* GitHubAppInstallationAuth;

          // Listed owner, 404 not installed -> write fails, read falls back
          const write404 = yield* auth
            .resolve({
              host: "github.com",
              repository: "macs-holding/uninstalled",
              access: "write",
            })
            .pipe(Effect.flip);
          expect(write404.message).toContain("not installed");
          const read404 = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/uninstalled",
            access: "read",
          });
          expect(read404.mode).toBe("personal");

          // Listed owner, missing private key -> write fails, read falls back
          const writeMissingKey = yield* auth
            .resolve({ host: "github.com", repository: "scrapline-hq/scrapline", access: "write" })
            .pipe(Effect.flip);
          expect(writeMissingKey.message).toContain("Could not read private key");
          const readMissingKey = yield* auth.resolve({
            host: "github.com",
            repository: "scrapline-hq/scrapline",
            access: "read",
          });
          expect(readMissingKey.mode).toBe("personal");

          // Listed owner, mint error (HTTP 500) -> write fails, read falls back
          const writeMintFail = yield* auth
            .resolve({ host: "github.com", repository: "macs-holding/mint-fail", access: "write" })
            .pipe(Effect.flip);
          expect(writeMintFail.message).toContain("Failed to mint GitHub App installation token");
          const readMintFail = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/mint-fail",
            access: "read",
          });
          expect(readMintFail.mode).toBe("personal");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("fails writes closed on malformed or duplicate-owner apps file; reads fall back", () =>
    Effect.gen(function* () {
      for (const content of [
        "{ broken json",
        JSON.stringify({
          apps: [
            { name: "a", appId: 1, privateKeyPath: "/a.pem", owners: ["dup"] },
            { name: "b", appId: 2, privateKeyPath: "/b.pem", owners: ["DUP"] },
          ],
        }),
      ]) {
        const files = { "/etc/bad-apps.json": content };
        const config = yield* loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/bad-apps.json" },
          fileSystem: fakeFileSystem(files),
        });
        expect(config.mode).toBe("apps-file-error");
        const http = makeFakeHttp(() => ({ status: 500, body: {} }));
        const layer = provideAuth(config, files, http.layer);

        yield* Effect.gen(function* () {
          const auth = yield* GitHubAppInstallationAuth;
          const writeErr = yield* auth
            .resolve({ host: "github.com", repository: "any/repo", access: "write" })
            .pipe(Effect.flip);
          expect(writeErr.message).toContain("Refusing to fall back to personal account");

          const readRes = yield* auth.resolve({
            host: "github.com",
            repository: "any/repo",
            access: "read",
          });
          expect(readRes.mode).toBe("personal");
        }).pipe(Effect.provide(layer));
      }
    }),
  );

  it.effect("supports single-app installed-or-personal fallback when apps file is absent", () =>
    Effect.gen(function* () {
      const files = { "/keys/omegent.pem": TEST_KEY_A };
      const config = yield* loadGitHubAppAgentAuthConfig({
        env: {
          T3_GITHUB_APP_AUTH: "1",
          T3_GITHUB_APP_ROUTING: "installed-or-personal",
          T3CODE_GITHUB_APP_ID: "4331997",
          T3CODE_GITHUB_APP_PRIVATE_KEY_PATH: "/keys/omegent.pem",
        },
        fileSystem: fakeFileSystem(files),
      });
      const http = makeFakeHttp((req) => {
        if (req.url.endsWith("/repos/macs-holding/shop/installation")) {
          return { status: 200, body: { id: 101 } };
        }
        if (req.url.endsWith("/repos/patroza/t3code/installation")) {
          return { status: 404, body: { message: "Not Found" } };
        }
        if (req.url.endsWith("/repos/broken/repo/installation")) {
          return { status: 502, body: { message: "Bad Gateway" } };
        }
        if (req.url.endsWith("/app/installations/101/access_tokens")) {
          return {
            status: 201,
            body: { token: "single-app-tok", expires_at: "2099-01-01T01:00:00Z" },
          };
        }
        if (req.url.endsWith("/app")) {
          return { status: 200, body: { slug: "omegent-app" } };
        }
        return { status: 404, body: {} };
      });
      const layer = provideAuth(config, files, http.layer);

      yield* Effect.gen(function* () {
        const auth = yield* GitHubAppInstallationAuth;

        const installed = yield* auth.resolve({
          host: "github.com",
          repository: "macs-holding/shop",
          access: "write",
        });
        expect(installed.mode).toBe("app");

        // Confirmed 404 -> personal on write
        const notInstalled = yield* auth.resolve({
          host: "github.com",
          repository: "patroza/t3code",
          access: "write",
        });
        expect(notInstalled).toEqual({ mode: "personal", configured: true });

        // API 502 -> fails closed on write, falls back to personal on read
        const writeErr = yield* auth
          .resolve({ host: "github.com", repository: "broken/repo", access: "write" })
          .pipe(Effect.flip);
        expect(writeErr.status).toBe(502);

        const readFallback = yield* auth.resolve({
          host: "github.com",
          repository: "broken/repo",
          access: "read",
        });
        expect(readFallback.mode).toBe("personal");
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "caches installation tokens until shortly before expiry and remints after skew window",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1_800_000_000_000);
        let mintCount = 0;
        const files = {
          "/keys/omegent.pem": TEST_KEY_A,
          "/etc/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "/keys/omegent.pem",
                owners: ["macs-holding"],
              },
            ],
          }),
        };
        const config = yield* loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json" },
          fileSystem: fakeFileSystem(files),
        });
        const http = makeFakeHttp((req) => {
          if (req.url.endsWith("/repos/macs-holding/shop/installation")) {
            return { status: 200, body: { id: 101 } };
          }
          if (req.url.endsWith("/app/installations/101/access_tokens")) {
            mintCount += 1;
            const expiresAt = DateTime.formatIso(
              DateTime.makeUnsafe(1_800_000_000_000 + mintCount * 3_600_000),
            );
            return { status: 201, body: { token: `tok-${mintCount}`, expires_at: expiresAt } };
          }
          if (req.url.endsWith("/app")) {
            return { status: 200, body: { slug: "omegent-app" } };
          }
          return { status: 404, body: {} };
        });
        const layer = provideAuth(config, files, http.layer);

        yield* Effect.gen(function* () {
          const auth = yield* GitHubAppInstallationAuth;
          const first = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
          });
          expect(first.mode).toBe("app");
          if (first.mode === "app") expect(Redacted.value(first.token)).toBe("tok-1");

          // 30 minutes later: still fresh, must hit cache
          yield* TestClock.adjust(Duration.minutes(30));
          const second = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
          });
          expect(mintCount).toBe(1);
          if (second.mode === "app") expect(Redacted.value(second.token)).toBe("tok-1");

          // 29 minutes later (total 59m, within 120s skew window): must remint
          yield* TestClock.adjust(Duration.minutes(29));
          const third = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
          });
          expect(mintCount).toBe(2);
          if (third.mode === "app") expect(Redacted.value(third.token)).toBe("tok-2");
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect(
    "routes per-repo entries on unmapped owners and overrides owner entries (case-insensitive)",
    () =>
      Effect.gen(function* () {
        const files = {
          "/keys/omegent.pem": TEST_KEY_A,
          "/keys/scrapline.pem": TEST_KEY_B,
          "/etc/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "/keys/omegent.pem",
                owners: ["macs-holding"],
                repos: ["patroza/effect-ui-ssr-lazy-routes"],
              },
              {
                name: "scrapline-multica",
                appId: 5677773,
                privateKeyPath: "/keys/scrapline.pem",
                owners: ["scrapline-hq"],
                repos: ["macs-holding/private-override"],
              },
            ],
          }),
        };
        const config = yield* loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json" },
          fileSystem: fakeFileSystem(files),
        });
        expect(config.mode).toBe("apps-file");
        const http = makeFakeHttp((req) => {
          const iss = jwtIssuer(req.authHeader);
          if (req.url.endsWith("/repos/PATROZA/Effect-UI-SSR-Lazy-Routes/installation")) {
            return { status: 200, body: { id: 301 } };
          }
          if (req.url.endsWith("/repos/macs-holding/private-override/installation")) {
            return { status: 200, body: { id: 302 } };
          }
          if (req.url.endsWith("/app/installations/301/access_tokens")) {
            return {
              status: 201,
              body: { token: `tok-${iss}-301`, expires_at: "2099-01-01T01:00:00Z" },
            };
          }
          if (req.url.endsWith("/app/installations/302/access_tokens")) {
            return {
              status: 201,
              body: { token: `tok-${iss}-302`, expires_at: "2099-01-01T01:00:00Z" },
            };
          }
          if (req.url.endsWith("/app")) {
            return {
              status: 200,
              body: { slug: iss === "4331997" ? "omegent-app" : "scrapline-multica" },
            };
          }
          return { status: 404, body: { message: "Not Found" } };
        });

        const layer = provideAuth(config, files, http.layer);
        yield* Effect.gen(function* () {
          const auth = yield* GitHubAppInstallationAuth;

          // Repo entry on an otherwise unmapped owner (case-insensitive) -> omegent-app
          const repoOnUnmappedOwner = yield* auth.resolve({
            host: "github.com",
            repository: "PATROZA/Effect-UI-SSR-Lazy-Routes",
            access: "write",
          });
          expect(repoOnUnmappedOwner.mode).toBe("app");
          if (repoOnUnmappedOwner.mode === "app") {
            expect(repoOnUnmappedOwner.appId).toBe("4331997");
            expect(repoOnUnmappedOwner.actor).toBe("omegent-app[bot]");
          }

          // Other repo under same unmapped owner -> personal
          const otherRepoOnOwner = yield* auth.resolve({
            host: "github.com",
            repository: "patroza/t3code",
            access: "write",
          });
          expect(otherRepoOnOwner).toEqual({ mode: "personal", configured: true });

          // Repo entry overrides another app's owner entry -> scrapline-multica wins over omegent-app
          const repoOverridesOwner = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/private-override",
            access: "write",
          });
          expect(repoOverridesOwner.mode).toBe("app");
          if (repoOverridesOwner.mode === "app") {
            expect(repoOverridesOwner.appId).toBe("5677773");
            expect(repoOverridesOwner.actor).toBe("scrapline-multica[bot]");
          }
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("does nothing when App auth is unconfigured", () =>
    Effect.gen(function* () {
      const http = makeFakeHttp(() => ({ status: 500, body: {} }));
      const layer = provideAuth({ mode: "disabled", agentPolicy: false }, {}, http.layer);
      const decision = yield* Effect.flatMap(GitHubAppInstallationAuth, (auth) =>
        auth.resolve({ host: "github.com", repository: "macs-holding/shop", access: "write" }),
      ).pipe(Effect.provide(layer));
      expect(decision).toEqual({ mode: "personal", configured: false });
      expect(http.calls).toHaveLength(0);
    }),
  );
});
