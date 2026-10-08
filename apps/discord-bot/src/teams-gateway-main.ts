// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalPromise:off missingEffectContext:off anyUnknownInErrorContext:off unsafeEffectTypeAssertion:off layerMergeAllWithDependencies:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { App } from "@microsoft/teams.apps";
import { NodeRuntime } from "@effect/platform-node";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { ProviderUserInputAnswers } from "@t3tools/contracts";
import { DiscordBotConfig } from "./config.ts";
import { resolveProjectFromShortName, startOrContinueT3Turn } from "./features/LinkedTurnRouter.ts";
import { waitForFinalAnswer } from "./features/TeamsNativeApp.ts";
import { finalAnswerText } from "./features/ResponseBridge.ts";
import { IdentityMapStore, layerFromOptionalPath as identityMapLayer } from "./identityMap.ts";
import { layerFromOptionalPath as aliasesLayer } from "./projectAliases.ts";
import { ThreadLinkStore, layer as linksLayer } from "./store/ThreadLinkStore.ts";
import { T3Session, layer as sessionLayer } from "./t3/T3Session.ts";
import { readGatewayConfig, readPrivateCredential } from "./teams/gatewayConfig.ts";
import { TeamsGatewayDispatcher } from "./teams/gatewayDispatcher.ts";
import { LoopbackTeamsAdapter, RedactedTeamsLogger } from "./teams/gatewayHttp.ts";
import {
  TeamsGatewayPolicy,
  type GatewayActivity,
  type GatewayLease,
} from "./teams/gatewayPolicy.ts";

const decodeAnswers = Schema.decodeUnknownEffect(Schema.fromJsonString(ProviderUserInputAnswers));

const program = Effect.gen(function* () {
  const configPath = process.env.TEAMS_GATEWAY_CONFIG;
  const secretPath = process.env.TEAMS_GATEWAY_BOT_SECRET_FILE;
  const stateDir = process.env.TEAMS_GATEWAY_STATE_DIR;
  if (!configPath || !secretPath || !stateDir || !NodePath.isAbsolute(stateDir)) {
    return yield* Effect.die(
      new Error(
        "TEAMS_GATEWAY_CONFIG, TEAMS_GATEWAY_BOT_SECRET_FILE and absolute TEAMS_GATEWAY_STATE_DIR are required",
      ),
    );
  }
  const initial = readGatewayConfig(configPath);
  // Explicit config provider prevents another tenant's credentials/defaults leaking from host env.
  const defaults = yield* DiscordBotConfig.pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord({}))),
  );
  const entries = yield* Effect.forEach(
    Object.entries(initial.workspaces).filter(([, workspace]) => workspace.enabled),
    Effect.fn(function* ([id, workspace]) {
      const config: DiscordBotConfig = {
        ...defaults,
        t3HttpBaseUrl: workspace.t3HttpBaseUrl!,
        t3BearerToken: readPrivateCredential(workspace.credentialFile!),
        t3BootstrapCredential: undefined,
        dataDir: workspace.dataDir!,
        webUiBaseUrl: workspace.webOrigin,
        publicWebUiBaseUrl: workspace.webOrigin,
        projectAliasesPath: workspace.projectAliasesPath,
        identityMapPath: workspace.identityMapPath,
        t3DefaultBaseBranch: workspace.defaultBaseBranch ?? defaults.t3DefaultBaseBranch,
        t3DefaultInstanceId: workspace.defaultInstanceId ?? defaults.t3DefaultInstanceId,
        t3DefaultModel: workspace.defaultModel ?? defaults.t3DefaultModel,
        teamsEnabled: false,
        teamsNativeEnabled: false,
      };
      NodeFS.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
      if (NodeFS.statSync(config.dataDir).mode & 0o077)
        return yield* Effect.die(new Error("Workspace state must be private"));
      const runtime = ManagedRuntime.make(
        Layer.mergeAll(
          sessionLayer(config),
          linksLayer(config.dataDir),
          aliasesLayer(config.projectAliasesPath),
          identityMapLayer(config.identityMapPath),
        ),
      );
      yield* Effect.addFinalizer(() => runtime.disposeEffect);
      const identities = yield* Effect.promise(() => runtime.runPromise(IdentityMapStore));
      runtime.runFork(Effect.flatMap(T3Session, (session) => session.connectUntilReady()));
      return [id, { runtime, config, identities }] as const;
    }),
  );
  const workspaces = new Map(entries);
  const policy = new TeamsGatewayPolicy(
    () => readGatewayConfig(configPath),
    stateDir,
    (workspace, actor) =>
      workspaces
        .get(workspace)
        ?.identities.list()
        .some((person) => person.teams?.aadObjectId?.toLowerCase() === actor) === true,
  );
  yield* Effect.forkScoped(
    Effect.sync(() => {
      try {
        policy.sweep();
      } catch {
        /* config errors fail closed */
      }
    }).pipe(Effect.repeat(Schedule.spaced("30 seconds"))),
  );
  let running = true;
  const dispatcher = new TeamsGatewayDispatcher(policy);
  const app = new App({
    clientId: initial.identity.entraClientId,
    clientSecret: readPrivateCredential(secretPath),
    tenantId: initial.identity.homeTenantId,
    messagingEndpoint: "/api/messages",
    skipAuth: false,
    activity: { mentions: { stripText: true } },
    logger: new RedactedTeamsLogger(),
    httpServerAdapter: new LoopbackTeamsAdapter(),
  });
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      running = false;
      return app.stop();
    }),
  );

  const active = (lease: GatewayLease) => {
    if (!running || !policy.isActive(lease))
      throw new Error("Teams binding was revoked or changed");
    return workspaces.get(lease.binding.workspace)!;
  };

  app.on("message", async ({ activity, send, reply }) => {
    // Structural SDK activity type narrows to the fields read by the independent policy.
    dispatcher.receive(activity as GatewayActivity, async (decision) => {
      const { lease } = decision;
      const workspace = active(lease);
      const deliver = async (text: string, first = false) => {
        active(lease);
        return first ? reply(text) : send(text);
      };
      const processMessage = Effect.gen(function* () {
        active(lease);
        const t3 = yield* T3Session;
        const links = yield* ThreadLinkStore;
        yield* t3.waitUntilReady({ timeoutMs: 15000 });
        active(lease);
        const { project } = yield* resolveProjectFromShortName(lease.binding.projectShortName!);
        if (project.id !== lease.binding.projectId)
          return yield* Effect.fail("Teams project binding mismatch" as const);
        const sourceKey =
          "native/" +
          [
            lease.binding.tenantId,
            lease.binding.teamId,
            lease.binding.channelId,
            lease.conversationId,
          ].join("/");
        const existing = yield* links.getBySourceThread("teams", sourceKey);
        if (existing !== null && existing.projectId !== project.id)
          return yield* Effect.fail("Existing Teams link belongs to another project" as const);
        const snapshot =
          existing === null ? null : yield* t3.fetchThreadDetail(existing.t3ThreadId);
        if (snapshot !== null && snapshot.thread.projectId !== project.id)
          return yield* Effect.fail("Linked thread belongs to another project" as const);
        active(lease);
        const prompt = decision.text;
        if (/^(?:\/?stop|cancel)$/iu.test(prompt)) {
          if (existing !== null) yield* t3.interrupt(existing.t3ThreadId);
          yield* Effect.promise(() =>
            deliver(
              existing === null ? "There is no linked T3 thread." : "Stopped the active T3 turn.",
              true,
            ),
          );
          return;
        }
        const approval = /^(?:\/?)(approve|deny)\s+(\S+)$/iu.exec(prompt);
        if (approval !== null) {
          if (existing !== null)
            yield* t3.respondToApproval(
              existing.t3ThreadId,
              approval[2]!,
              approval[1]!.toLowerCase() === "approve" ? "accept" : "decline",
            );
          yield* Effect.promise(() =>
            deliver(
              existing === null
                ? "There is no linked T3 thread."
                : "Submitted the approval decision.",
              true,
            ),
          );
          return;
        }
        const answer = /^(?:\/?)answer\s+(\S+)\s+(.+)$/isu.exec(prompt);
        if (answer !== null) {
          if (existing === null) {
            yield* Effect.promise(() => deliver("There is no linked T3 thread.", true));
            return;
          }
          const answers = yield* decodeAnswers(answer[2]!);
          active(lease);
          yield* t3.respondToUserInput(existing.t3ThreadId, answer[1]!, answers);
          yield* Effect.promise(() => deliver("Submitted the requested input.", true));
          return;
        }
        const enriched = [decision.context, "Authorized Teams request:\n" + prompt]
          .filter(Boolean)
          .join("\n\n");
        const turn = yield* startOrContinueT3Turn(workspace.config, {
          source: { sourceKind: "teams", sourceThreadId: sourceKey },
          externalConversationId: lease.conversationId,
          externalParentId: lease.binding.teamId + "/" + lease.binding.channelId,
          externalTenantId: lease.binding.tenantId,
          projectShortName: lease.binding.projectShortName!,
          prompt: enriched,
          flags: {},
          stickyModelOnContinue: true,
          promptContext: { kind: "raw", value: enriched },
        });
        yield* Effect.promise(() =>
          deliver(
            "[Open in T3 Code](" +
              workspace.config.webUiBaseUrl +
              "/?thread=" +
              turn.threadId +
              ")",
            true,
          ),
        );
        yield* Effect.forkDetach(
          waitForFinalAnswer({
            t3ThreadId: turn.threadId,
            baseline: snapshot === null ? "" : finalAnswerText(snapshot.thread),
            baselineTurnId: snapshot?.thread.latestTurn?.turnId ?? null,
            send: (text) => deliver(text),
            canDeliver: () => running && policy.isActive(lease),
          }).pipe(Effect.timeout("1 hour"), Effect.ignoreCause),
        );
      });
      await workspace.runtime.runPromise(processMessage).catch(async () => {
        try {
          await deliver(
            "T3 could not process this request. Please submit a new mention or contact an operator.",
            true,
          );
        } catch {
          /* revoked: no reply */
        }
      });
    });
    // Acknowledge immediately; T3 work and Teams delivery continue on the host queue.
  });
  app.on("install.remove", async ({ activity }) => {
    policy.revoke(activity as GatewayActivity);
  });
  // Personal/group chats and message-action project overrides have no binding in v1.
  app.on("message.ext.open", async () => ({
    task: {
      type: "message" as const,
      value: "Mention the bot in an authorized channel to start T3.",
    },
  }));
  app.on("message.ext.submit", async () => ({
    task: {
      type: "message" as const,
      value: "Mention the bot in an authorized channel to start T3.",
    },
  }));
  yield* Effect.promise(() => app.start(Number(initial.ingress.dispatcherListen.split(":")[1])));
  yield* Effect.logInfo("Shared Teams gateway started", { workspaces: entries.map(([id]) => id) });
  return yield* Effect.never;
});

NodeRuntime.runMain(Effect.scoped(program));
