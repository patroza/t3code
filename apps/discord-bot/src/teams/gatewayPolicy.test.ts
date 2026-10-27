// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalTimers:off globalPromise:off globalErrorInErrorChannel:off
import { App } from "@microsoft/teams.apps";
import { registerTeamsMessageEvents } from "./messageEvents.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { parseGatewayConfig, type TeamsGatewayConfig } from "./gatewayConfig.ts";
import { TeamsGatewayDispatcher, type MentionDecision } from "./gatewayDispatcher.ts";
import { TeamsResponseReferences } from "./responseReferences.ts";
import { TeamsGatewayPolicy, safeTeamsServiceUrl, type GatewayActivity } from "./gatewayPolicy.ts";

const appId = "11111111-1111-4111-8111-111111111111";
const tenant = "22222222-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333";
const team = "44444444-4444-4444-8444-444444444444";
const project = "55555555-5555-4555-8555-555555555555";
function rawConfig(directory: string) {
  return {
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
  };
}
function fixture(directory: string): TeamsGatewayConfig {
  return parseGatewayConfig(rawConfig(directory));
}

describe("shared Teams gateway", () => {
  let directory: string;
  let config: TeamsGatewayConfig;
  let now: number;
  let policy: TeamsGatewayPolicy;
  let sequence: number;
  function activity(overrides: Partial<GatewayActivity> = {}): GatewayActivity {
    return {
      type: "message",
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
  function groupActivity(overrides: Partial<GatewayActivity> = {}): GatewayActivity {
    return activity({
      text: "secret customer text",
      entities: [],
      channelData: { tenant: { id: tenant } },
      conversation: {
        id: "19:mako@thread.v2",
        tenantId: tenant,
        conversationType: "groupChat",
        name: "MAKO Scanner",
      },
      ...overrides,
    });
  }
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "teams-gateway-"));
    config = fixture(directory);
    now = Date.parse("2026-10-21T12:00:00.000Z");
    sequence = 0;
    policy = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
  });
  afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  class ReceivingApp extends App {
    async receive(input: GatewayActivity) {
      for (const handler of this.router.select(
        input as Parameters<Parameters<App["message"]>[1]>[0]["activity"],
      )) {
        await handler({ activity: input } as Parameters<Parameters<App["message"]>[1]>[0]);
      }
    }
  }
  function receiver(
    dispatcher: TeamsGatewayDispatcher,
    execute: (decision: MentionDecision) => Promise<void>,
  ) {
    const app = new ReceivingApp({ clientId: appId });
    registerTeamsMessageEvents(app, async ({ activity: input }, edited) => {
      dispatcher.receive(
        {
          ...input,
          type: edited ? "messageUpdate" : "message",
          channelData: { ...input.channelData, ...(edited ? { eventType: "editMessage" } : {}) },
        } as GatewayActivity,
        execute,
      );
    });
    return app;
  }
  it("starts work once when a Teams edit adds the bot mention to an ambient message", async () => {
    const dispatcher = new TeamsGatewayDispatcher(policy);
    const execute = vi.fn(async (_decision: MentionDecision) => {});
    const app = receiver(dispatcher, execute);
    const original = activity({ entities: [], text: "Please check the order" });
    await app.receive(original);
    const edited = {
      ...original,
      type: "messageUpdate",
      text: "Please check the order now",
      entities: activity().entities!,
      channelData: { ...original.channelData, eventType: "editMessage" },
    };
    await app.receive(edited);
    await app.receive(edited);
    await app.receive({ ...edited, text: "Another correction" });
    await dispatcher.drain();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].text).toBe("Please check the order now");
    expect(execute.mock.calls[0]?.[0].context).not.toContain("Please check the order");
  });
  it("ignores edits of messages that already triggered and edits that do not mention this bot", async () => {
    const dispatcher = new TeamsGatewayDispatcher(policy);
    const execute = vi.fn(async (_decision: MentionDecision) => {});
    const app = receiver(dispatcher, execute);
    const original = activity();
    await app.receive(original);
    await app.receive({
      ...original,
      type: "messageUpdate",
      channelData: { ...original.channelData, eventType: "editMessage" },
      text: "Corrected request",
    });
    await app.receive(
      activity({
        type: "messageUpdate",
        entities: [],
        channelData: { ...original.channelData, eventType: "editMessage" },
      }),
    );
    await app.receive(
      activity({
        type: "messageUpdate",
        channelData: { ...original.channelData, eventType: "undeleteMessage" },
      }),
    );
    await app.receive(
      activity({
        type: "messageUpdate",
        from: { id: "unknown", aadObjectId: "unknown" },
        channelData: { ...original.channelData, eventType: "editMessage" },
      }),
    );
    await dispatcher.drain();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("preserves ambient-to-mentioned edit eligibility and consumed triggers across restarts", () => {
    const original = activity({ entities: [] });
    expect(policy.accept(original).kind).toBe("ambient");
    policy = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
    const edited = {
      ...original,
      type: "messageUpdate",
      entities: activity().entities!,
      channelData: { ...original.channelData, eventType: "editMessage" },
    };
    expect(policy.accept(edited).kind).toBe("mention");
    policy = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
    expect(policy.accept(edited)).toMatchObject({ kind: "reject", reason: "duplicate" });
  });
  it("restores private response references only while their original authorization is active", () => {
    const decision = policy.accept(activity());
    expect(decision.kind).toBe("mention");
    if (decision.kind !== "mention") return;
    const references = new TeamsResponseReferences(directory);
    references.remember(decision.lease, "https://smba.trafficmanager.net/emea/", "root");
    const restored = new TeamsResponseReferences(directory);
    expect(restored.restore(config, (lease) => policy.isActive(lease))).toHaveLength(1);
    expect(NodeFS.statSync(NodePath.join(directory, "response-references.json")).mode & 0o077).toBe(
      0,
    );
    config = {
      ...config,
      bindings: config.bindings.map((binding) => ({ ...binding, enabled: false })),
    };
    expect(restored.restore(config, (lease) => policy.isActive(lease))).toEqual([]);
    expect(() =>
      references.remember(decision.lease, "https://attacker.invalid/", "root"),
    ).toThrow();
  });
  it("authorizes card invokes through the same envelope and actor policy without a mention", () => {
    const invoke = activity({ type: "invoke", entities: [] });
    expect(policy.authorizeAction(invoke)?.actorId).toBe(actor);
    expect(policy.authorizeAction(invoke)).toBeNull();
    expect(
      policy.authorizeAction(
        activity({ type: "invoke", from: { id: "stranger", aadObjectId: project } }),
      ),
    ).toBeNull();
    expect(policy.authorizeAction(activity({ type: "message", entities: [] }))).toBeNull();
  });

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
  it("dispatches real Teams channel data using the Entra group ID and revokes it on uninstall", async () => {
    config = {
      ...config,
      bindings: config.bindings.map((binding) => ({
        ...binding,
        teamConversationId: "19:team-conversation@thread.tacv2",
      })),
    };
    const channelData = {
      tenant: { id: tenant },
      team: { id: "19:team-conversation@thread.tacv2", aadGroupId: team },
      channel: { id: "channel-alpha" },
    };
    const dispatcher = new TeamsGatewayDispatcher(policy);
    const execute = vi.fn(async (decision: MentionDecision) => {
      expect(decision).toMatchObject({
        lease: { binding: { teamId: team, workspace: "alpha" } },
      });
    });
    expect(dispatcher.receive(activity({ channelData }), execute)).toBe("queued");
    expect(
      dispatcher.receive(
        activity({
          channelData: { ...channelData, team: { id: "19:team-conversation@thread.tacv2" } },
        }),
        execute,
      ),
    ).toBe("queued");
    await dispatcher.drain();
    expect(execute).toHaveBeenCalledTimes(2);
    policy.revoke(activity({ channelData }));
    expect(dispatcher.receive(activity({ channelData }), execute)).toBe("reject:revoked-binding");
    await dispatcher.drain();
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it("does not fall back to team.id when an explicit Entra group ID differs", () => {
    expect(
      policy.accept(
        activity({
          channelData: {
            tenant: { id: tenant },
            team: { id: team, aadGroupId: "66666666-6666-4666-8666-666666666666" },
            channel: { id: "channel-alpha" },
          },
        }),
      ),
    ).toMatchObject({ kind: "reject", reason: "unbound-location" });
    config = {
      ...config,
      bindings: config.bindings.map((binding) => ({
        ...binding,
        teamConversationId: "19:expected@thread.tacv2",
      })),
    };
    expect(
      policy.accept(
        activity({
          channelData: {
            tenant: { id: tenant },
            team: { id: "19:wrong@thread.tacv2", aadGroupId: team },
            channel: { id: "channel-alpha" },
          },
        }),
      ),
    ).toMatchObject({ kind: "reject", reason: "unbound-location" });
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
    const betaFinished = Promise.withResolvers<void>();
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
        betaFinished.resolve();
      },
    );
    await betaFinished.promise;
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

  it("does not store a group chat, and does not run it as a channel mention", async () => {
    const dispatcher = new TeamsGatewayDispatcher(policy);
    const execute = vi.fn(async (_decision: MentionDecision) => {});
    expect(policy.accept(groupActivity())).toMatchObject({ kind: "reject", reason: "group-chat" });
    expect(dispatcher.receive(groupActivity(), execute)).toBe("reject:group-chat");
    await dispatcher.drain();
    expect(execute).not.toHaveBeenCalled();
    expect(
      policy.acceptGroupChat(
        activity({
          conversation: { id: "19:dm", tenantId: tenant, conversationType: "personal" },
          channelData: undefined,
          entities: [],
          text: "secret",
        }),
      ),
    ).toEqual({ kind: "not-group" });
    expect(policy.accept(activity())).toMatchObject({ kind: "mention", context: "" });
  });

  it("routes a scanner group chat without storing the customer text", () => {
    config = {
      ...config,
      workspaces: {
        ...config.workspaces,
        alpha: { ...config.workspaces.alpha!, scannerGroupChats: true },
      },
    } as TeamsGatewayConfig;
    const routed = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
    const decision = routed.acceptGroupChat(groupActivity({ id: "mako-1" }));
    expect(decision).toMatchObject({
      kind: "handle",
      workspaceId: "alpha",
      builtinScanner: true,
    });
    expect(JSON.stringify(decision)).not.toContain("secret");
    expect(routed.acceptGroupChat(groupActivity({ id: "mako-1" }))).toMatchObject({
      kind: "reject",
      reason: "duplicate",
    });
    expect(
      routed.acceptGroupChat(
        groupActivity({
          id: "alfa-1",
          conversation: {
            id: "19:alfa@thread.v2",
            tenantId: tenant,
            conversationType: "groupChat",
            name: "Alfa Omega Configurator",
          },
        }),
      ),
    ).toMatchObject({ kind: "silent", reason: "unmapped" });
    expect(routed.accept(activity())).toMatchObject({ kind: "mention", context: "" });
  });

  it("lets a conversation pin beat the scanner workspace", () => {
    const mirror = {
      tenantId: "77777777-7777-4777-8777-777777777777",
      teamId: "88888888-8888-4888-8888-888888888888",
      channelId: "19:ihd@thread.tacv2",
    };
    config = {
      ...config,
      workspaces: {
        ...config.workspaces,
        alpha: { ...config.workspaces.alpha!, scannerGroupChats: true },
        beta: {
          ...config.workspaces.beta!,
          groupChats: [
            {
              conversationId: "19:mako@thread.v2",
              projectShortName: "project-beta",
              mirrorTenantId: mirror.tenantId,
              mirrorTeamId: mirror.teamId,
              mirrorChannelId: mirror.channelId,
            },
          ],
        },
      },
    } as TeamsGatewayConfig;
    const routed = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
    expect(routed.acceptGroupChat(groupActivity())).toMatchObject({
      kind: "handle",
      workspaceId: "beta",
      builtinScanner: false,
      rules: [
        {
          conversationId: "19:mako@thread.v2",
          projectShortName: "project-beta",
          mirror,
        },
      ],
    });
  });

  it("stays silent when two workspaces would both observe the chat", () => {
    config = {
      ...config,
      workspaces: {
        alpha: { ...config.workspaces.alpha!, scannerGroupChats: true },
        beta: { ...config.workspaces.beta!, scannerGroupChats: true },
      },
    } as TeamsGatewayConfig;
    const routed = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
    expect(routed.acceptGroupChat(groupActivity())).toMatchObject({
      kind: "silent",
      reason: "ambiguous",
    });
    expect(JSON.stringify(routed.accept(activity()))).not.toContain("secret");
    expect(routed.accept(activity())).toMatchObject({ kind: "mention", context: "" });
  });

  it("requires discord for group chat routing and a single scanner workspace", () => {
    const raw = rawConfig(directory);
    expect(() =>
      parseGatewayConfig({
        ...raw,
        workspaces: {
          ...raw.workspaces,
          alpha: { ...raw.workspaces.alpha, scannerGroupChats: true },
        },
      }),
    ).toThrow(/discord/u);
    const discord = {
      tokenFile: directory + "/discord-token",
      alertsChannelId: "123456789012345678",
    };
    expect(() =>
      parseGatewayConfig({
        ...raw,
        discord,
        workspaces: {
          alpha: { ...raw.workspaces.alpha, scannerGroupChats: true },
          beta: { ...raw.workspaces.beta, scannerGroupChats: true },
        },
      }),
    ).toThrow(/scannerGroupChats/u);
    expect(() =>
      parseGatewayConfig({
        ...raw,
        discord,
        workspaces: {
          ...raw.workspaces,
          alpha: {
            ...raw.workspaces.alpha,
            scannerGroupChats: true,
            scannerMirrorTenantId: "77777777-7777-4777-8777-777777777777",
          },
        },
      }),
    ).toThrow(/scannerMirror/u);
    const parsed = parseGatewayConfig({
      ...raw,
      discord,
      workspaces: {
        ...raw.workspaces,
        alpha: { ...raw.workspaces.alpha, scannerGroupChats: true },
      },
    });
    expect(parsed.discord?.alertsChannelId).toBe(discord.alertsChannelId);
    expect(parsed.workspaces.alpha?.scannerGroupChats).toBe(true);
  });
});
