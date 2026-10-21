// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off globalPromise:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { TeamsResponseReferences } from "./responseReferences.ts";
import { parseGatewayConfig } from "./gatewayConfig.ts";
import { TeamsGatewayDispatcher } from "./gatewayDispatcher.ts";
import { TeamsGatewayPolicy, type GatewayActivity } from "./gatewayPolicy.ts";

const app = "11111111-1111-4111-8111-111111111111";
const tenant = "abcdefab-2222-4222-8222-222222222222";
const actor = "33333333-3333-4333-8333-333333333333";
const secondActor = "66666666-6666-4666-8666-666666666666";
const team = "abcdefab-4444-4444-8444-444444444444";
const project = "55555555-5555-4555-8555-555555555555";
function fixture(directory: string) {
  return {
    version: 2,
    enabled: true,
    identity: { entraClientId: app, homeTenantId: tenant },
    ingress: { dispatcherListen: "127.0.0.1:3979" },
    workspaces: {
      alpha: {
        enabled: true,
        webOrigin: "https://alpha.example.com",
        t3HttpBaseUrl: "https://alpha.internal",
        credentialFile: directory + "/token",
        dataDir: directory + "/alpha",
        identityMapPath: directory + "/map",
        projectAliasesPath: directory + "/projects",
      },
    },
    teamInstallations: [
      {
        id: "alpha-team",
        enabled: true,
        workspace: "alpha",
        tenantId: tenant,
        teamId: team,
        allowedActorIds: [actor],
      },
    ],
    bindings: ["one", "two"].map((channelId) => ({
      id: channelId,
      enabled: true,
      installationId: "alpha-team",
      scope: "channel",
      channelId,
      projectShortName: "project-" + channelId,
      projectId: project,
    })),
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

describe("Teams team installations", () => {
  let directory: string;
  let config: ReturnType<typeof fixture>;
  let policy: TeamsGatewayPolicy;
  let sequence: number;
  let mapped: Set<string>;
  function activity(channelId = "one", actorId = actor, text = "Investigate"): GatewayActivity {
    return {
      id: "activity-" + sequence++,
      channelId: "msteams",
      timestamp: "2026-10-21T12:00:00.000Z",
      serviceUrl: "https://smba.trafficmanager.net/emea/",
      from: { id: "human", aadObjectId: actorId },
      recipient: { id: "28:" + app },
      conversation: { id: "conversation-" + channelId, tenantId: tenant },
      channelData: { tenant: { id: tenant }, team: { id: team }, channel: { id: channelId } },
      text,
      entities: [{ type: "mention", mentioned: { id: "28:" + app } }],
    };
  }
  beforeEach(() => {
    directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "teams-installations-"));
    config = fixture(directory);
    sequence = 0;
    mapped = new Set([actor, secondActor]);
    policy = new TeamsGatewayPolicy(
      () => parseGatewayConfig(config),
      directory,
      (_, id) => mapped.has(id),
      () => Date.parse("2026-10-21T12:00:00.000Z"),
    );
  });
  afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));

  it("retains explicitly allowed channel description routing in v2 installations", () => {
    const input = {
      ...config,
      bindings: config.bindings.map((binding) => ({
        ...binding,
        useChannelDescription: true,
        descriptionProjectShortNames: [binding.projectShortName],
      })),
    };
    const parsed = parseGatewayConfig(input);
    expect(parsed.bindings[0]?.useChannelDescription).toBe(true);
    expect(parsed.bindings[0]?.descriptionProjectShortNames).toEqual(["project-one"]);
  });

  it("retains a separate public origin and wires it into generated public links", () => {
    const input = {
      ...config,
      workspaces: {
        alpha: { ...config.workspaces.alpha, publicWebOrigin: "https://public" },
      },
    };
    const workspace = parseGatewayConfig(input).workspaces.alpha!;
    expect(workspace.webOrigin).toBe("https://alpha.example.com");
    expect(workspace.publicWebOrigin).toBe("https://public");
    const runtime = NodeFS.readFileSync(
      new URL("../teams-gateway-main.ts", import.meta.url),
      "utf8",
    );
    expect(runtime).toContain(
      "publicWebUiBaseUrl: workspace.publicWebOrigin ?? workspace.webOrigin",
    );
  });

  it.each([
    "http://public",
    "https://user:secret@public",
    "https://public/path",
    "https://public/?token=x",
    "https://public/#fragment",
  ])("rejects unsafe public origin %s", (publicWebOrigin) => {
    const input = {
      ...config,
      workspaces: { alpha: { ...config.workspaces.alpha, publicWebOrigin } },
    };
    expect(() => parseGatewayConfig(input)).toThrow("fixed HTTPS origins");
  });

  it("matches UUID casing and revokes the entire installation on uninstall", () => {
    const incoming = activity();
    const mixedCase = {
      ...incoming,
      conversation: { ...incoming.conversation, tenantId: tenant.toUpperCase() },
      channelData: {
        ...incoming.channelData,
        team: { id: team.toUpperCase(), aadGroupId: team.toUpperCase() },
      },
    };
    const accepted = policy.accept(mixedCase);
    expect(accepted.kind).toBe("mention");
    policy.revoke(mixedCase);
    expect(policy.accept(activity("two"))).toMatchObject({
      kind: "reject",
      reason: "revoked-binding",
    });
  });

  it("reauthorizes persisted response references after actor removal and uninstall", () => {
    config.teamInstallations[0]!.allowedActorIds.push(secondActor);
    const references = new TeamsResponseReferences(directory);
    for (const channel of ["one", "two"]) {
      const accepted = policy.accept(activity(channel));
      expect(accepted.kind).toBe("mention");
      if (accepted.kind === "mention")
        references.remember(accepted.lease, "https://smba.trafficmanager.net/emea/", "root");
    }
    const restored = new TeamsResponseReferences(directory);
    const restore = () =>
      restored.restore(parseGatewayConfig(config), (lease) => policy.isActive(lease));
    expect(restore()).toHaveLength(2);
    config.teamInstallations[0]!.allowedActorIds = [secondActor];
    expect(restore()).toEqual([]);
    config.teamInstallations[0]!.allowedActorIds.push(actor);
    policy.revoke(activity());
    expect(restore()).toEqual([]);
  });

  it("inherits one team's actors and workspace across both project routes", () => {
    for (const channel of ["one", "two"]) {
      const result = policy.accept(activity(channel));
      expect(result.kind).toBe("mention");
      if (result.kind === "mention") {
        expect(result.lease.binding.workspace).toBe("alpha");
        expect(result.lease.binding.projectShortName).toBe("project-" + channel);
      }
      expect(policy.accept(activity(channel, secondActor))).toMatchObject({
        kind: "reject",
        reason: "unauthorized-actor",
      });
    }
    config.teamInstallations[0]!.allowedActorIds.push(secondActor);
    expect(policy.accept(activity("one", secondActor)).kind).toBe("mention");
    expect(policy.accept(activity("two", secondActor)).kind).toBe("mention");
    expect(policy.accept(activity("unconfigured", secondActor)).kind).toBe("reject");
  });

  it("still requires a verified identity in addition to installation authorization", () => {
    mapped.clear();
    expect(policy.accept(activity())).toMatchObject({
      kind: "reject",
      reason: "unauthorized-actor",
    });
  });

  it("actor removal revokes delivery and ambient context across all team channels", () => {
    const leases = ["one", "two"].map((channel) => {
      const result = policy.accept(activity(channel));
      if (result.kind !== "mention") throw new Error("Expected mention");
      return result.lease;
    });
    policy.accept({ ...activity("one", actor, "Old private context"), entities: [] });
    config.teamInstallations[0]!.allowedActorIds = [secondActor];
    expect(leases.every((lease) => !policy.isActive(lease))).toBe(true);
    const result = policy.accept(activity("one", secondActor));
    expect(result.kind).toBe("mention");
    if (result.kind === "mention") expect(result.context).not.toContain("Old private context");
    expect(policy.accept(activity("two", actor)).kind).toBe("reject");
  });

  it("team disabling and uninstall revoke every channel lease", () => {
    const leases = ["one", "two"].map((channel) => {
      const result = policy.accept(activity(channel));
      if (result.kind !== "mention") throw new Error("Expected mention");
      return result.lease;
    });
    config.teamInstallations[0]!.enabled = false;
    expect(leases.every((lease) => !policy.isActive(lease))).toBe(true);
    expect(policy.accept(activity()).kind).toBe("reject");
    config.teamInstallations[0]!.enabled = true;
    policy.revoke(activity());
    expect(leases.every((lease) => !policy.isActive(lease))).toBe(true);
    expect(policy.accept(activity("two"))).toMatchObject({
      kind: "reject",
      reason: "revoked-binding",
    });
  });

  it("drops queued execution when installation authorization changes", async () => {
    const dispatcher = new TeamsGatewayDispatcher(policy);
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const firstStarted = Promise.withResolvers<void>();
    dispatcher.receive(activity("one"), async () => {
      started++;
      firstStarted.resolve();
      await barrier;
    });
    dispatcher.receive(activity("two"), async () => {
      started++;
    });
    await firstStarted.promise;
    config.teamInstallations[0]!.allowedActorIds = [secondActor];
    release();
    await dispatcher.drain();
    expect(started).toBe(1);
  });

  it("rejects duplicate teams, unknown references, and channel authorization overrides", () => {
    expect(() =>
      parseGatewayConfig({
        ...config,
        teamInstallations: [
          ...config.teamInstallations,
          { ...config.teamInstallations[0], id: "other-install" },
        ],
      }),
    ).toThrow("Ambiguous Teams team installation");
    expect(() =>
      parseGatewayConfig({
        ...config,
        bindings: [{ ...config.bindings[0], installationId: "unknown" }],
      }),
    ).toThrow("Unknown team installation");
    for (const shadow of [
      { allowedActorIds: [secondActor] },
      { workspace: "beta" },
      { teamId: project },
      { tenantId: project },
    ]) {
      expect(() =>
        parseGatewayConfig({ ...config, bindings: [{ ...config.bindings[0], ...shadow }] }),
      ).toThrow();
    }
    expect(() =>
      parseGatewayConfig({
        ...config,
        teamInstallations: [{ ...config.teamInstallations[0], allowedActorIds: [] }],
      }),
    ).toThrow("actor mappings");
  });
});
