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

  it("parses optional reviewer with ~ expansion, ignores unknown fields, and rejects malformed reviewer", () => {
    const parsed = parseGitHubAppsFile(
      JSON.stringify({
        apps: [
          {
            name: "omegent-app",
            appId: 4331997,
            privateKeyPath: "~/.config/t3/opener.pem",
            owners: ["macs-holding"],
            reviewer: {
              name: "omegent-reviewer",
              appId: 9988776,
              privateKeyPath: "~/.config/t3/reviewer.pem",
              unknownReviewerField: "ignored",
            },
          },
          {
            name: "no-reviewer-app",
            appId: 5677773,
            privateKeyPath: "/etc/keys/opener2.pem",
            owners: ["scrapline-hq"],
          },
        ],
      }),
      "/home/alice/.config/t3/github-apps.json",
      "/home/alice",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.ownerMap.get("macs-holding")?.reviewer).toEqual({
      name: "omegent-reviewer",
      appId: "9988776",
      privateKeyPath: "/home/alice/.config/t3/reviewer.pem",
    });
    expect(parsed.ownerMap.get("scrapline-hq")?.reviewer).toBeUndefined();

    for (const badReviewer of [
      { name: "rev", appId: "not-a-number", privateKeyPath: "/r.pem" },
      { name: "rev", appId: 123, privateKeyPath: "   " },
      { name: "rev", appId: -5, privateKeyPath: "/r.pem" },
      { name: "rev", privateKeyPath: "/r.pem" },
      "not-an-object",
      null,
    ]) {
      const bad = parseGitHubAppsFile(
        JSON.stringify({
          apps: [
            {
              name: "omegent-app",
              appId: 4331997,
              privateKeyPath: "/o.pem",
              owners: ["macs-holding"],
              reviewer: badReviewer,
            },
          ],
        }),
        "/tmp/apps.json",
      );
      expect(bad.ok).toBe(false);
    }
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
            T3CODE_GITHUB_APP_ID: "9999",
            T3CODE_GITHUB_APP_PRIVATE_KEY_PATH: "/other.pem",
          },
          homeDir: "/home/pat",
          fileSystem: fakeFileSystem(files),
        });
        expect(fromFile.mode).toBe("apps-file");

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
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json" },
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

  it.effect(
    "routes fork base repo to its mapped App and unmapped upstream base repo to personal",
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
                owners: ["macs-holding", "aaaomega"],
                repos: ["patroza/effect-ui-ssr-lazy-routes", "patroza/t3code"],
              },
            ],
          }),
        };
        const config = yield* loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json" },
          fileSystem: fakeFileSystem(files),
        });
        const http = makeFakeHttp((req) => {
          if (req.url.endsWith("/repos/patroza/t3code/installation")) {
            return { status: 200, body: { id: 401 } };
          }
          if (req.url.endsWith("/app/installations/401/access_tokens")) {
            return {
              status: 201,
              body: { token: "tok-fork-401", expires_at: "2099-01-01T01:00:00Z" },
            };
          }
          if (req.url.endsWith("/app")) {
            return { status: 200, body: { slug: "omegent-app" } };
          }
          return { status: 404, body: { message: "Not Found" } };
        });
        const layer = provideAuth(config, files, http.layer);

        yield* Effect.gen(function* () {
          const auth = yield* GitHubAppInstallationAuth;

          // PR opened in the mapped fork (head + base in patroza/t3code) -> omegent-app
          const forkPr = yield* auth.resolve({
            host: "github.com",
            repository: "patroza/t3code",
            access: "write",
          });
          expect(forkPr.mode).toBe("app");
          if (forkPr.mode === "app") {
            expect(forkPr.appId).toBe("4331997");
            expect(forkPr.actor).toBe("omegent-app[bot]");
          }

          // PR opened against unmapped upstream base repo (pingdotgg/t3code) -> personal
          const upstreamPr = yield* auth.resolve({
            host: "github.com",
            repository: "pingdotgg/t3code",
            access: "write",
          });
          expect(upstreamPr).toEqual({ mode: "personal", configured: true });

          // Another repo under patroza not in repos[] -> personal
          const otherPersonal = yield* auth.resolve({
            host: "github.com",
            repository: "patroza/other-repo",
            access: "write",
          });
          expect(otherPersonal).toEqual({ mode: "personal", configured: true });
        }).pipe(Effect.provide(layer));
      }),
  );

  it.effect("does nothing when App auth is unconfigured", () =>
    Effect.gen(function* () {
      const http = makeFakeHttp(() => ({ status: 500, body: {} }));
      const layer = provideAuth({ mode: "disabled" }, {}, http.layer);
      const decision = yield* Effect.flatMap(GitHubAppInstallationAuth, (auth) =>
        auth.resolve({ host: "github.com", repository: "macs-holding/shop", access: "write" }),
      ).pipe(Effect.provide(layer));
      expect(decision).toEqual({ mode: "personal", configured: false });
      expect(http.calls).toHaveLength(0);
    }),
  );

  it.effect("harmlessly ignores leftover policy env vars when loading config", () =>
    Effect.gen(function* () {
      const files = {
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
      const legacyEnvKey = ["T3_GITHUB_APP", "AGENT", "POLICY"].join("_");
      const config = yield* loadGitHubAppAgentAuthConfig({
        env: {
          T3_GITHUB_APPS_FILE: "/etc/github-apps.json",
          T3_GITHUB_APP_ROUTING: "installed-or-personal",
          [legacyEnvKey]: "1",
        },
        fileSystem: fakeFileSystem(files),
      });
      expect(config.mode).toBe("apps-file");
      expect("agentPolicy" in config).toBe(false);
    }),
  );

  it.effect(
    "routes reviewer role to the configured reviewer App with separate caches and reviewer permissions",
    () =>
      Effect.gen(function* () {
        const files = {
          "/keys/opener.pem": TEST_KEY_A,
          "/keys/reviewer.pem": TEST_KEY_B,
          "/etc/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "/keys/opener.pem",
                owners: ["macs-holding"],
                reviewer: {
                  name: "omegent-reviewer",
                  appId: 9988776,
                  privateKeyPath: "/keys/reviewer.pem",
                },
              },
              {
                name: "scrapline-multica",
                appId: 5677773,
                privateKeyPath: "/keys/opener.pem",
                owners: ["scrapline-hq"],
              },
            ],
          }),
        };
        const config = yield* loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json" },
          fileSystem: fakeFileSystem(files),
        });
        const mintBodies: Array<{ readonly iss: string | null; readonly body: unknown }> = [];
        const http = makeFakeHttp((req) => {
          const iss = jwtIssuer(req.authHeader);
          if (req.url.endsWith("/repos/macs-holding/shop/installation")) {
            return { status: 200, body: { id: iss === "9988776" ? 901 : 101 } };
          }
          if (req.url.endsWith("/repos/scrapline-hq/scrapline/installation")) {
            return { status: 200, body: { id: 202 } };
          }
          if (req.url.endsWith("/app/installations/101/access_tokens")) {
            mintBodies.push({ iss, body: req.body });
            return {
              status: 201,
              body: { token: "opener-tok-101", expires_at: "2099-01-01T01:00:00Z" },
            };
          }
          if (req.url.endsWith("/app/installations/901/access_tokens")) {
            mintBodies.push({ iss, body: req.body });
            return {
              status: 201,
              body: { token: "reviewer-tok-901", expires_at: "2099-01-01T01:00:00Z" },
            };
          }
          if (req.url.endsWith("/app/installations/202/access_tokens")) {
            mintBodies.push({ iss, body: req.body });
            return {
              status: 201,
              body: { token: "scrapline-tok-202", expires_at: "2099-01-01T01:00:00Z" },
            };
          }
          if (req.url.endsWith("/app")) {
            return {
              status: 200,
              body: {
                slug:
                  iss === "9988776"
                    ? "omegent-reviewer"
                    : iss === "4331997"
                      ? "omegent-app"
                      : "scrapline-multica",
              },
            };
          }
          return { status: 404, body: {} };
        });

        const layer = provideAuth(config, files, http.layer);
        yield* Effect.gen(function* () {
          const auth = yield* GitHubAppInstallationAuth;

          const opener = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
          });
          expect(opener.mode).toBe("app");
          if (opener.mode === "app") {
            expect(opener.appId).toBe("4331997");
            expect(opener.actor).toBe("omegent-app[bot]");
            expect(opener.installationId).toBe(101);
            expect(Redacted.value(opener.token)).toBe("opener-tok-101");
          }

          const reviewer = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
            role: "reviewer",
          });
          expect(reviewer.mode).toBe("app");
          if (reviewer.mode === "app") {
            expect(reviewer.appId).toBe("9988776");
            expect(reviewer.actor).toBe("omegent-reviewer[bot]");
            expect(reviewer.installationId).toBe(901);
            expect(Redacted.value(reviewer.token)).toBe("reviewer-tok-901");
          }

          // Subsequent calls hit separate caches with no extra HTTP requests
          const callsBeforeCacheCheck = http.calls.length;
          const openerAgain = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
          });
          const reviewerAgain = yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
            role: "reviewer",
          });
          expect(http.calls.length).toBe(callsBeforeCacheCheck);
          if (openerAgain.mode === "app") {
            expect(Redacted.value(openerAgain.token)).toBe("opener-tok-101");
          }
          if (reviewerAgain.mode === "app") {
            expect(Redacted.value(reviewerAgain.token)).toBe("reviewer-tok-901");
          }

          // Invalidating opener does not evict reviewer
          yield* auth.invalidate({
            appId: "4331997",
            host: "github.com",
            repository: "macs-holding/shop",
          });
          const callsBeforeReviewerAfterInvalidate = http.calls.length;
          yield* auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
            role: "reviewer",
          });
          expect(http.calls.length).toBe(callsBeforeReviewerAfterInvalidate);

          // Entry without reviewer falls back to opener App unchanged
          const noReviewer = yield* auth.resolve({
            host: "github.com",
            repository: "scrapline-hq/scrapline",
            access: "write",
            role: "reviewer",
          });
          expect(noReviewer.mode).toBe("app");
          if (noReviewer.mode === "app") {
            expect(noReviewer.appId).toBe("5677773");
            expect(noReviewer.actor).toBe("scrapline-multica[bot]");
          }
        }).pipe(Effect.provide(layer));

        const reviewerMint = mintBodies.find((entry) => entry.iss === "9988776");
        expect(reviewerMint?.body).toEqual({
          permissions: {
            pull_requests: "write",
            contents: "read",
            metadata: "read",
          },
          repositories: ["shop"],
        });
      }),
  );

  it.effect(
    "falls back to unscoped permissions when reviewer App lacks an optional permission on 422",
    () =>
      Effect.gen(function* () {
        const files = {
          "/keys/opener.pem": TEST_KEY_A,
          "/keys/reviewer.pem": TEST_KEY_B,
          "/etc/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "omegent-app",
                appId: 4331997,
                privateKeyPath: "/keys/opener.pem",
                owners: ["macs-holding"],
                reviewer: {
                  name: "omegent-reviewer",
                  appId: 9988776,
                  privateKeyPath: "/keys/reviewer.pem",
                },
              },
            ],
          }),
        };
        const config = yield* loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json" },
          fileSystem: fakeFileSystem(files),
        });
        const mintBodies: Array<unknown> = [];
        const http = makeFakeHttp((req) => {
          if (req.url.endsWith("/repos/macs-holding/shop/installation")) {
            return { status: 200, body: { id: 901 } };
          }
          if (req.url.endsWith("/app/installations/901/access_tokens")) {
            mintBodies.push(req.body);
            if (mintBodies.length === 1) {
              return {
                status: 422,
                body: {
                  message: "The permissions requested are not granted to this installation.",
                },
              };
            }
            return {
              status: 201,
              body: { token: "reviewer-fallback-tok", expires_at: "2099-01-01T01:00:00Z" },
            };
          }
          if (req.url.endsWith("/app")) {
            return { status: 200, body: { slug: "omegent-reviewer" } };
          }
          return { status: 404, body: {} };
        });

        const layer = provideAuth(config, files, http.layer);
        const decision = yield* Effect.flatMap(GitHubAppInstallationAuth, (auth) =>
          auth.resolve({
            host: "github.com",
            repository: "macs-holding/shop",
            access: "write",
            role: "reviewer",
          }),
        ).pipe(Effect.provide(layer));

        expect(decision.mode).toBe("app");
        if (decision.mode === "app") {
          expect(Redacted.value(decision.token)).toBe("reviewer-fallback-tok");
        }
        expect(mintBodies).toEqual([
          {
            permissions: { pull_requests: "write", contents: "read", metadata: "read" },
            repositories: ["shop"],
          },
          { repositories: ["shop"] },
        ]);
      }),
  );

  it.effect(
    "fails closed when reviewer App key is missing, installation is 404, or mint fails; never falls back to opener",
    () =>
      Effect.gen(function* () {
        const files = {
          "/keys/opener.pem": TEST_KEY_A,
          "/keys/reviewer.pem": TEST_KEY_B,
          "/etc/github-apps.json": JSON.stringify({
            apps: [
              {
                name: "missing-key-opener",
                appId: 1001,
                privateKeyPath: "/keys/opener.pem",
                owners: ["org-missing-key"],
                reviewer: {
                  name: "missing-key-reviewer",
                  appId: 2001,
                  privateKeyPath: "/keys/does-not-exist.pem",
                },
              },
              {
                name: "uninstalled-opener",
                appId: 1002,
                privateKeyPath: "/keys/opener.pem",
                owners: ["org-uninstalled"],
                reviewer: {
                  name: "uninstalled-reviewer",
                  appId: 2002,
                  privateKeyPath: "/keys/reviewer.pem",
                },
              },
              {
                name: "mint-fail-opener",
                appId: 1003,
                privateKeyPath: "/keys/opener.pem",
                owners: ["org-mint-fail"],
                reviewer: {
                  name: "mint-fail-reviewer",
                  appId: 2003,
                  privateKeyPath: "/keys/reviewer.pem",
                },
              },
            ],
          }),
        };
        const config = yield* loadGitHubAppAgentAuthConfig({
          env: { T3_GITHUB_APPS_FILE: "/etc/github-apps.json" },
          fileSystem: fakeFileSystem(files),
        });
        const http = makeFakeHttp((req) => {
          const iss = jwtIssuer(req.authHeader);
          if (req.url.endsWith("/repos/org-uninstalled/repo/installation")) {
            // Opener IS installed, reviewer is NOT
            return iss === "1002"
              ? { status: 200, body: { id: 102 } }
              : { status: 404, body: { message: "Not Found" } };
          }
          if (req.url.endsWith("/repos/org-mint-fail/repo/installation")) {
            return { status: 200, body: { id: iss === "2003" ? 903 : 103 } };
          }
          if (req.url.endsWith("/app/installations/903/access_tokens")) {
            return { status: 500, body: { message: "Internal Server Error" } };
          }
          return { status: 201, body: { token: "opener-tok", expires_at: "2099-01-01T01:00:00Z" } };
        });

        const layer = provideAuth(config, files, http.layer);
        yield* Effect.gen(function* () {
          const auth = yield* GitHubAppInstallationAuth;

          const missingKeyErr = yield* auth
            .resolve({
              host: "github.com",
              repository: "org-missing-key/repo",
              access: "write",
              role: "reviewer",
            })
            .pipe(Effect.flip);
          expect(missingKeyErr.message).toContain("Could not read private key");
          expect(missingKeyErr.message).toContain("reviewer missing-key-reviewer");

          const notInstalledErr = yield* auth
            .resolve({
              host: "github.com",
              repository: "org-uninstalled/repo",
              access: "write",
              role: "reviewer",
            })
            .pipe(Effect.flip);
          expect(notInstalledErr.message).toContain("not installed");
          expect(notInstalledErr.message).toContain("refusing to fall back to opener App");

          const mintFailErr = yield* auth
            .resolve({
              host: "github.com",
              repository: "org-mint-fail/repo",
              access: "write",
              role: "reviewer",
            })
            .pipe(Effect.flip);
          expect(mintFailErr.message).toContain("Failed to mint GitHub App installation token");
          expect(mintFailErr.message).toContain("reviewer mint-fail-reviewer");
        }).pipe(Effect.provide(layer));
      }),
  );
});
