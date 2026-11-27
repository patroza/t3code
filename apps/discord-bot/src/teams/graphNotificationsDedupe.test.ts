// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { parseGatewayConfig, type TeamsGatewayConfig } from "./gatewayConfig.ts";
import { pinnedGroupChatIds } from "./graphChatSubscriptions.ts";
import { graphChatMessageToActivity } from "./graphNotifications.ts";
import { TeamsGatewayPolicy, type GatewayActivity } from "./gatewayPolicy.ts";

const appId = "11111111-1111-4111-8111-111111111111";
const tenant = "22222222-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333";
const chatId = "19:pinned_chat@thread.v2";

function rawConfig(directory: string) {
  return {
    version: 1,
    enabled: true,
    identity: { entraClientId: appId, homeTenantId: tenant },
    ingress: { dispatcherListen: "127.0.0.1:3980" },
    discord: { tokenFile: directory + "/discord-token", alertsChannelId: "123456789012345678" },
    workspaces: {
      alpha: {
        enabled: true,
        webOrigin: "https://alpha.example.com",
        t3HttpBaseUrl: "https://alpha.internal",
        credentialFile: directory + "/alpha-token",
        dataDir: directory + "/alpha",
        identityMapPath: directory + "/alpha-map",
        projectAliasesPath: directory + "/alpha-projects",
        groupChats: [{ conversationId: chatId, projectShortName: "support" }],
      },
      off: {
        enabled: false,
        webOrigin: "https://off.example.com",
        groupChats: [{ conversationId: "19:off@thread.v2", projectShortName: "x" }],
      },
    },
    bindings: [
      {
        id: "alpha",
        enabled: true,
        workspace: "alpha",
        scope: "channel",
        tenantId: tenant,
        teamId: "44444444-4444-4444-8444-444444444444",
        channelId: "channel-alpha",
        allowedActorIds: [actor],
        projectShortName: "project-alpha",
        projectId: "55555555-5555-4555-8555-555555555555",
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

describe("Graph notifications config and dedupe", () => {
  let directory: string;
  let config: TeamsGatewayConfig;
  let now: number;
  let policy: TeamsGatewayPolicy;
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "teams-graph-"));
    config = parseGatewayConfig({
      ...rawConfig(directory),
      graphNotifications: { publicBaseUrl: "https://gateway.example.com/" },
    });
    now = Date.parse("2026-11-27T10:00:05.000Z");
    policy = new TeamsGatewayPolicy(
      () => config,
      directory,
      () => true,
      () => now,
    );
  });
  afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

  it("parses graphNotifications strictly and keeps it optional", () => {
    const raw = rawConfig(directory);
    expect(parseGatewayConfig(raw).graphNotifications).toBeUndefined();
    expect(config.graphNotifications).toEqual({ publicBaseUrl: "https://gateway.example.com/" });
    for (const publicBaseUrl of [
      "http://gateway.example.com",
      "not a url",
      "https://user:pass@gateway.example.com",
      "https://gateway.example.com/?x=1",
    ]) {
      expect(() => parseGatewayConfig({ ...raw, graphNotifications: { publicBaseUrl } })).toThrow(
        /graphNotifications/u,
      );
    }
    expect(() => parseGatewayConfig({ ...raw, graphNotifications: {} })).toThrow();
  });

  it("subscribes only to chats pinned by id in enabled workspaces", () => {
    expect(pinnedGroupChatIds(config)).toEqual([chatId]);
  });

  it("a changed graphNotifications key does not stop intake until restart", () => {
    config = parseGatewayConfig({
      ...rawConfig(directory),
      graphNotifications: { publicBaseUrl: "https://other.example.com" },
    });
    expect(policy.acceptGroupChat(botActivity("1795594328400"))).toMatchObject({ kind: "handle" });
  });

  function botActivity(id: string): GatewayActivity {
    return {
      type: "message",
      id,
      channelId: "msteams",
      timestamp: new Date(now).toISOString(),
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      from: { id: "29:human", aadObjectId: actor, name: "Ada" },
      recipient: { id: "28:" + appId },
      conversation: { id: chatId, tenantId: tenant, conversationType: "groupChat", isGroup: true },
      channelData: { tenant: { id: tenant } },
      text: "printer is down",
      entities: [],
    };
  }
  const graphActivity = (id: string) => {
    const mapped = graphChatMessageToActivity(
      {
        id,
        messageType: "message",
        createdDateTime: "2026-11-27T10:00:00.000Z",
        from: { user: { id: actor, displayName: "Ada" } },
        body: { contentType: "html", content: "<p>printer is down</p>" },
      },
      {
        chatId,
        tenantId: tenant,
        botAppId: appId,
        serviceUrl: "https://smba.trafficmanager.net/teams",
      },
    );
    if (mapped.kind !== "activity") throw new Error("expected an activity");
    return mapped.activity;
  };

  it("ingests a message delivered by the bot and by Graph once, in either order", () => {
    // Teams uses the chat message id as the bot activity id.
    expect(policy.acceptGroupChat(botActivity("1795594328476"))).toMatchObject({
      kind: "handle",
      workspaceId: "alpha",
    });
    expect(policy.acceptGroupChat(graphActivity("1795594328476"), "graph")).toEqual({
      kind: "reject",
      reason: "duplicate",
    });
    expect(policy.acceptGroupChat(graphActivity("1795594328477"), "graph")).toMatchObject({
      kind: "handle",
    });
    expect(policy.acceptGroupChat(botActivity("1795594328477"))).toEqual({
      kind: "reject",
      reason: "duplicate",
    });
    // A Teams-sent conversation id carrying ;messageid= still claims the same chat.
    expect(
      policy.acceptGroupChat({
        ...botActivity("1795594328477"),
        conversation: {
          ...botActivity("1795594328477").conversation,
          id: chatId + ";messageid=1795594328477",
        },
      }),
    ).toEqual({ kind: "reject", reason: "duplicate" });
  });

  it("does not hold Graph messages to the Bot Framework envelope", () => {
    now += 2 * 86_400_000;
    expect(policy.acceptGroupChat(graphActivity("1795594328500"), "graph")).toMatchObject({
      kind: "handle",
    });
    expect(policy.acceptGroupChat(botActivity("1795594328501"))).toMatchObject({
      kind: "handle",
    });
    expect(policy.acceptGroupChat({ ...graphActivity("1795594328502"), id: "" }, "graph")).toEqual({
      kind: "reject",
      reason: "invalid-envelope",
    });
  });
});
