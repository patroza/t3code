// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalTimers:off globalPromise:off globalErrorInErrorChannel:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseGatewayConfig, type TeamsGatewayConfig } from "./gatewayConfig.ts";
import { TeamsGatewayDispatcher } from "./gatewayDispatcher.ts";
import { TeamsGatewayPolicy, safeTeamsServiceUrl, type GatewayActivity } from "./gatewayPolicy.ts";

const appId = "11111111-1111-4111-8111-111111111111";
const tenant = "22222222-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333";
const team = "44444444-4444-4444-8444-444444444444";
const project = "55555555-5555-4555-8555-555555555555";
function fixture(directory: string): TeamsGatewayConfig {
  return parseGatewayConfig({
    version: 1,
    enabled: true,
    identity: { entraClientId: appId, homeTenantId: tenant },
    ingress: { dispatcherListen: "127.0.0.1:3979" },
    workspaces: {
      alpha: {
        enabled: true,
        webOrigin: "https://alpha.example.com",
        t3HttpBaseUrl: "https://alpha.internal",
        credentialFile: directory + "/alpha-token",
        dataDir: directory + "/alpha",
        identityMapPath: directory + "/alpha-map",
        projectAliasesPath: directory + "/alpha-projects",
      },
      beta: {
        enabled: true,
        webOrigin: "https://beta.example.com",
        t3HttpBaseUrl: "https://beta.internal",
        credentialFile: directory + "/beta-token",
        dataDir: directory + "/beta",
        identityMapPath: directory + "/beta-map",
        projectAliasesPath: directory + "/beta-projects",
      },
    },
    bindings: [
      {
        id: "alpha",
        enabled: true,
        workspace: "alpha",
        scope: "channel",
        tenantId: tenant,
        teamId: team,
        channelId: "channel-alpha",
        allowedActorIds: [actor],
        projectShortName: "project-alpha",
        projectId: project,
      },
      {
        id: "beta",
        enabled: true,
        workspace: "beta",
        scope: "channel",
        tenantId: tenant,
        teamId: team,
        channelId: "channel-beta",
        allowedActorIds: [actor],
        projectShortName: "project-beta",
        projectId: project,
      },
    ],
    messageIntake: {
      ambient: "context-only",
      ambientActorPolicy: "authorized-actors-only",
      ambientCanExecute: false,
      contextTrust: "untrusted-quoted-content",
      trigger: "explicit-mention-authorized-actor",
      dropUnmappedBeforeStorage: true,
      maxContextMessages: 2,
      contextTtlSeconds: 60,
    },
  });
}

describe("shared Teams gateway", () => {
  let directory: string;
  let config: TeamsGatewayConfig;
  let now: number;
  let policy: TeamsGatewayPolicy;
  let sequence: number;
  function activity(overrides: Partial<GatewayActivity> = {}): GatewayActivity {
    return {
      id: "activity-" + sequence++,
      channelId: "msteams",
      timestamp: new Date(now).toISOString(),
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      from: { id: "human", aadObjectId: actor },
      recipient: { id: "28:" + appId },
      conversation: { id: "conversation-alpha", tenantId: tenant },
      channelData: { tenant: { id: tenant }, team: { id: team }, channel: { id: "channel-alpha" } },
      text: "Investigate this",
      entities: [{ type: "mention", mentioned: { id: "28:" + appId } }],
      ...overrides,
    };
  }
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "teams-gateway-"));
    config = fixture(directory);
    now = Date.now();
    sequence = 0;
    policy = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
  });
  afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

  it("routes the same actor to different workspaces exclusively by exact channel", () => {
    expect(policy.accept(activity())).toMatchObject({
      kind: "mention",
      lease: { binding: { workspace: "alpha" } },
    });
    expect(
      policy.accept(
        activity({
          channelData: {
            tenant: { id: tenant },
            team: { id: team },
            channel: { id: "channel-beta" },
          },
        }),
      ),
    ).toMatchObject({ kind: "mention", lease: { binding: { workspace: "beta" } } });
  });
  it("rejects unknown channels, tenants and personal chats without storing content", () => {
    for (const channelData of [
      undefined,
      { tenant: { id: "unknown" }, team: { id: team }, channel: { id: "channel-alpha" } },
      { tenant: { id: tenant }, team: { id: team }, channel: { id: "unknown" } },
    ]) {
      expect(
        policy.accept(activity({ channelData, entities: [], text: "secret ambient" })),
      ).toMatchObject({ kind: "reject" });
    }
    expect(policy.accept(activity())).toMatchObject({ kind: "mention", context: "" });
  });
  it("rejects an unmapped actor before storing ambient text", () => {
    expect(
      policy.accept(
        activity({ from: { id: "human", aadObjectId: "unknown" }, text: "secret", entities: [] }),
      ),
    ).toMatchObject({ kind: "reject", reason: "unauthorized-actor" });
    const notMapped = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => false,
      () => now,
    );
    expect(notMapped.accept(activity({ text: "secret", entities: [] }))).toMatchObject({
      kind: "reject",
      reason: "unauthorized-actor",
    });
    expect(policy.accept(activity())).toMatchObject({ context: "" });
  });
  it("never executes ambient commands and only passes quoted context with an explicit mention", async () => {
    const dispatcher = new TeamsGatewayDispatcher(policy);
    const execute = vi.fn(async (_decision: unknown) => {});
    for (const text of ["stop", "approve id", "answer id {}", "run this immediately"]) {
      expect(dispatcher.receive(activity({ entities: [], text }), execute)).toBe("ambient");
    }
    await dispatcher.drain();
    expect(execute).not.toHaveBeenCalled();
    dispatcher.receive(activity(), execute);
    await dispatcher.drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      kind: "mention",
      context: expect.stringContaining("untrusted quoted"),
    });
  });
  it("does not recognize textual or other-bot mentions as a work trigger", async () => {
    const dispatcher = new TeamsGatewayDispatcher(policy);
    const execute = vi.fn(async (_decision: unknown) => {});
    dispatcher.receive(activity({ text: "<at>bot</at> stop", entities: [] }), execute);
    dispatcher.receive(
      activity({ entities: [{ type: "mention", mentioned: { id: "another-bot" } }] }),
      execute,
    );
    await dispatcher.drain();
    expect(execute).not.toHaveBeenCalled();
  });
  it("bounds ambient count, expires on idle sweep and keeps conversations isolated", () => {
    for (const text of ["first", "second", "third"])
      policy.accept(activity({ text, entities: [] }));
    const result = policy.accept(activity());
    expect(result).toMatchObject({ context: expect.stringContaining("second") });
    expect(result).toMatchObject({ context: expect.not.stringContaining("first") });
    policy.accept(
      activity({
        text: "different conversation",
        entities: [],
        conversation: { id: "other", tenantId: tenant },
      }),
    );
    expect(policy.accept(activity())).toMatchObject({ context: "" });
    now += 61000;
    policy.sweep();
    expect(
      policy.accept(activity({ conversation: { id: "other", tenantId: tenant } })),
    ).toMatchObject({ context: "" });
  });
  it("survives restart without duplicate work or retained message bodies", () => {
    const input = activity();
    expect(policy.accept(input).kind).toBe("mention");
    policy = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
    expect(policy.accept(input)).toMatchObject({ kind: "reject", reason: "duplicate" });
    expect(
      NodeFS.readFileSync(NodePath.join(directory, "intake-state.json"), "utf8"),
    ).not.toContain(input.text);
  });
  it("revokes old leases and delivery on uninstall, including after restart", () => {
    const result = policy.accept(activity());
    if (result.kind !== "mention") throw new Error("expected mention");
    expect(policy.isActive(result.lease)).toBe(true);
    policy.revoke(activity());
    expect(policy.isActive(result.lease)).toBe(false);
    policy = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
    expect(policy.accept(activity())).toMatchObject({ kind: "reject", reason: "revoked-binding" });
  });
  it("rejects changed bindings and prevents pending work crossing a rebinding", async () => {
    const result = policy.accept(activity());
    if (result.kind !== "mention") throw new Error("expected mention");
    config = parseGatewayConfig({
      ...config,
      bindings: config.bindings.map((binding) =>
        binding.id === "alpha" ? { ...binding, workspace: "beta" } : binding,
      ),
    });
    expect(policy.isActive(result.lease)).toBe(false);
    expect(policy.accept(activity())).toMatchObject({
      kind: "mention",
      context: "",
      lease: { binding: { workspace: "beta" } },
    });
  });
  it("a slow workspace cannot block another or cause fallback", async () => {
    const dispatcher = new TeamsGatewayDispatcher(policy);
    const seen: string[] = [];
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    dispatcher.receive(activity(), async (decision) => {
      await blocked;
      seen.push(decision.lease.binding.workspace);
    });
    dispatcher.receive(
      activity({
        channelData: {
          tenant: { id: tenant },
          team: { id: team },
          channel: { id: "channel-beta" },
        },
      }),
      async (decision) => {
        seen.push(decision.lease.binding.workspace);
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(seen).toEqual(["beta"]);
    release();
    await dispatcher.drain();
    expect(seen).toEqual(["beta", "alpha"]);
  });
  it("rejects service URL SSRF, mismatched tenant and stale activity replay", () => {
    expect(policy.accept(activity({ serviceUrl: "http://127.0.0.1:3773" })).kind).toBe("reject");
    expect(policy.accept(activity({ conversation: { id: "x", tenantId: "other" } }))).toMatchObject(
      { reason: "tenant-mismatch" },
    );
    expect(
      policy.accept(activity({ timestamp: new Date(now - 86400001).toISOString() })).kind,
    ).toBe("reject");
    for (const url of [
      "https://smba.trafficmanager.net.evil.example/a",
      "https://evil@smba.trafficmanager.net/a",
      "https://smba.trafficmanager.net:8443/a",
    ])
      expect(safeTeamsServiceUrl(url)).toBe(false);
  });
  it("never re-executes an activity after actor edits or workspace rebinding", () => {
    const input = activity();
    expect(policy.accept(input).kind).toBe("mention");
    config = parseGatewayConfig({
      ...config,
      bindings: config.bindings.map((binding) =>
        binding.id === "alpha"
          ? {
              ...binding,
              workspace: "beta",
              allowedActorIds: [actor, "66666666-6666-4666-8666-666666666666"],
            }
          : binding,
      ),
    });
    expect(policy.accept(input)).toMatchObject({ kind: "reject", reason: "duplicate" });
  });
  it("rejects a startup snapshot inconsistent with the actual workspace connections", () => {
    const initial = config;
    config = parseGatewayConfig({
      ...config,
      workspaces: {
        ...config.workspaces,
        alpha: { ...config.workspaces.alpha, t3HttpBaseUrl: "https://changed.internal" },
      },
    });
    expect(
      () =>
        new TeamsGatewayPolicy(
          () => config,
          directory,
          () => true,
          () => now,
          initial,
        ),
    ).toThrow("restart required");
  });
  it("fails configuration validation for ambiguous routes, shared state, NodeHttp and empty actors", () => {
    expect(() =>
      parseGatewayConfig({
        ...config,
        bindings: [...config.bindings, { ...config.bindings[0], id: "duplicate" }],
      }),
    ).toThrow("Ambiguous");
    expect(() =>
      parseGatewayConfig({
        ...config,
        workspaces: {
          ...config.workspaces,
          beta: { ...config.workspaces.beta, dataDir: config.workspaces.alpha!.dataDir },
        },
      }),
    ).toThrow("share");
    expect(() =>
      parseGatewayConfig({
        ...config,
        workspaces: {
          ...config.workspaces,
          alpha: { ...config.workspaces.alpha, t3HttpBaseUrl: "http://localhost:3773" },
        },
      }),
    ).toThrow("HTTPS");
    expect(() =>
      parseGatewayConfig({ ...config, bindings: [{ ...config.bindings[0], allowedActorIds: [] }] }),
    ).toThrow("actor");
  });
});
