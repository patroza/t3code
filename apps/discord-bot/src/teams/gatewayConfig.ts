// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";

const Workspace = Schema.Struct({
  enabled: Schema.Boolean,
  webOrigin: Schema.String,
  t3HttpBaseUrl: Schema.optional(Schema.String),
  credentialFile: Schema.optional(Schema.String),
  dataDir: Schema.optional(Schema.String),
  projectAliasesPath: Schema.optional(Schema.String),
  identityMapPath: Schema.optional(Schema.String),
  defaultBaseBranch: Schema.optional(Schema.String),
  defaultInstanceId: Schema.optional(Schema.String),
  defaultModel: Schema.optional(Schema.String),
});
const Binding = Schema.Struct({
  id: Schema.String,
  enabled: Schema.Boolean,
  workspace: Schema.String,
  scope: Schema.Literal("channel"),
  tenantId: Schema.String,
  teamId: Schema.String,
  channelId: Schema.String,
  allowedActorIds: Schema.Array(Schema.String),
  projectShortName: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
});
const GatewayConfig = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  identity: Schema.Struct({ entraClientId: Schema.String, homeTenantId: Schema.String }),
  ingress: Schema.Struct({ dispatcherListen: Schema.String }),
  workspaces: Schema.Record(Schema.String, Workspace),
  bindings: Schema.Array(Binding),
  messageIntake: Schema.Struct({
    ambient: Schema.Literal("context-only"),
    ambientActorPolicy: Schema.Literal("authorized-actors-only"),
    ambientCanExecute: Schema.Literal(false),
    contextTrust: Schema.Literal("untrusted-quoted-content"),
    trigger: Schema.Literal("explicit-mention-authorized-actor"),
    dropUnmappedBeforeStorage: Schema.Literal(true),
    maxContextMessages: Schema.Number,
    contextTtlSeconds: Schema.Number,
  }),
});
export type TeamsGatewayConfig = typeof GatewayConfig.Type;
export type TeamsGatewayBinding = typeof Binding.Type;
export type TeamsGatewayWorkspace = typeof Workspace.Type;
export const isUuid = (value: string) =>
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value);

const decodeGatewayConfig = Schema.decodeUnknownSync(GatewayConfig);

export function parseGatewayConfig(value: unknown): TeamsGatewayConfig {
  const config = decodeGatewayConfig(value);
  if (
    !config.enabled ||
    !isUuid(config.identity.entraClientId) ||
    !isUuid(config.identity.homeTenantId)
  ) {
    throw new Error("Gateway requires an enabled configuration and explicit bot identity");
  }
  const port = /^127\.0\.0\.1:(\d+)$/u.exec(config.ingress.dispatcherListen)?.[1];
  if (port === undefined || Number(port) < 1024 || Number(port) > 65535) {
    throw new Error("Gateway dispatcher must use a loopback port between 1024 and 65535");
  }
  const intake = config.messageIntake;
  if (
    !Number.isInteger(intake.maxContextMessages) ||
    intake.maxContextMessages < 1 ||
    intake.maxContextMessages > 200 ||
    !Number.isInteger(intake.contextTtlSeconds) ||
    intake.contextTtlSeconds < 60 ||
    intake.contextTtlSeconds > 86400
  ) {
    throw new Error("Context must have bounded count and expiry");
  }
  const directories = new Set<string>();
  const origins = new Set<string>();
  for (const workspace of Object.values(config.workspaces)) {
    if (!workspace.enabled) continue;
    const origin = new URL(workspace.t3HttpBaseUrl ?? "");
    const web = new URL(workspace.webOrigin);
    if (
      origin.protocol !== "https:" ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      origin.pathname !== "/" ||
      web.protocol !== "https:" ||
      web.username ||
      web.password ||
      web.search ||
      web.hash ||
      web.pathname !== "/"
    ) {
      throw new Error("Workspaces require fixed HTTPS origins without embedded credentials");
    }
    for (const field of [
      "credentialFile",
      "dataDir",
      "projectAliasesPath",
      "identityMapPath",
    ] as const) {
      if (!workspace[field] || !NodePath.isAbsolute(workspace[field]))
        throw new Error("Workspace requires absolute " + field);
    }
    const directory = NodePath.resolve(workspace.dataDir!);
    if (directories.has(directory) || origins.has(origin.origin))
      throw new Error("Workspaces must not share T3 origins or state directories");
    for (const other of directories) {
      if (directory.startsWith(other + NodePath.sep) || other.startsWith(directory + NodePath.sep))
        throw new Error("Workspace state directories must not overlap");
    }
    directories.add(directory);
    origins.add(origin.origin);
  }
  const scopes = new Set<string>();
  const ids = new Set<string>();
  for (const binding of config.bindings) {
    if (ids.has(binding.id)) throw new Error("Duplicate binding ID");
    ids.add(binding.id);
    if (!binding.enabled) continue;
    const key = JSON.stringify([binding.tenantId, binding.teamId, binding.channelId]);
    if (scopes.has(key)) throw new Error("Ambiguous Teams channel binding");
    scopes.add(key);
    if (
      !config.workspaces[binding.workspace]?.enabled ||
      !isUuid(binding.tenantId) ||
      !isUuid(binding.teamId) ||
      !binding.channelId ||
      binding.channelId.includes("*") ||
      !binding.projectShortName ||
      !isUuid(binding.projectId ?? "") ||
      binding.allowedActorIds.length === 0 ||
      binding.allowedActorIds.some((actor) => !isUuid(actor))
    ) {
      throw new Error("Enabled bindings require exact workspace, project and actor mappings");
    }
  }
  if (scopes.size === 0) throw new Error("Gateway requires at least one enabled channel binding");
  return config;
}

export function readGatewayConfig(path: string): TeamsGatewayConfig {
  return parseGatewayConfig(JSON.parse(NodeFS.readFileSync(path, "utf8")));
}

/** Credentials are supplied by the host secret store, never by an activity or VM. */
export function readPrivateCredential(path: string): string {
  const stat = NodeFS.statSync(path);
  if ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.() || !stat.isFile()) {
    throw new Error("Gateway credential must be an owner-only regular file");
  }
  const value = NodeFS.readFileSync(path, "utf8").trim();
  if (!value) throw new Error("Gateway credential is empty");
  return value;
}
