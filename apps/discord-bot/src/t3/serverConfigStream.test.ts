import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ServerConfig,
  ServerProvider,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";
import { followBotServerConfig } from "./serverConfigStream.ts";

const config = Schema.decodeUnknownSync(ServerConfig)({
  environment: {
    environmentId: "provider-catalog-test",
    label: "test",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "t3_session",
  },
  cwd: "/tmp/workspace",
  keybindingsConfigPath: "/tmp/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/tmp/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
});

const claude = Schema.decodeUnknownSync(ServerProvider)({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T00:00:00.000Z",
  models: [{ slug: "claude-opus-5-5", name: "Opus" }],
});

describe("bot server config subscription", () => {
  effectIt.effect(
    "replaces the startup catalog when discovery finishes and when a provider is disabled",
    () =>
      Effect.gen(function* () {
        const events: ServerConfigStreamEvent[] = [
          { type: "snapshot", config },
          { type: "providerStatuses", payload: { providers: [claude] } },
          { type: "providerStatuses", payload: { providers: [{ ...claude, enabled: false }] } },
          { type: "snapshot", config },
        ];
        const seen: ServerConfig[] = [];
        yield* followBotServerConfig(
          { subscribeServerConfig: () => Stream.fromIterable(events) },
          (next) => seen.push(next),
        );
        expect(seen.map((next) => next.providers)).toEqual([
          [],
          [claude],
          [{ ...claude, enabled: false }],
          [],
        ]);
      }),
  );
});
