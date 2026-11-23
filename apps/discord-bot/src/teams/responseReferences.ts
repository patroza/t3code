// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type { TeamsGatewayConfig } from "./gatewayConfig.ts";
import { safeTeamsServiceUrl, type GatewayLease } from "./gatewayPolicy.ts";
import type { TeamsResponseActivity } from "./ResponseTransport.ts";

const Reference = Schema.Struct({
  bindingId: Schema.String,
  fingerprint: Schema.String,
  actorId: Schema.String,
  key: Schema.String,
  conversationId: Schema.String,
  serviceUrl: Schema.String,
  rootMessageId: Schema.String,
  updatedAt: Schema.String,
});
type Reference = typeof Reference.Type;
const decode = Schema.decodeUnknownSync(Schema.Array(Reference));
/** Only authenticated intake writes references; every restored lease must be reauthorized. */
export class TeamsResponseReferences {
  private readonly path: string;
  private rows: Reference[];
  constructor(stateDir: string) {
    this.path = NodePath.join(stateDir, "response-references.json");
    this.rows = NodeFS.existsSync(this.path)
      ? [...decode(JSON.parse(NodeFS.readFileSync(this.path, "utf8")))]
      : [];
  }
  remember(lease: GatewayLease, serviceUrl: string, rootMessageId: string): void {
    if (!safeTeamsServiceUrl(serviceUrl)) throw new Error("Unsafe Teams response service URL");
    const row = {
      bindingId: lease.binding.id,
      fingerprint: lease.fingerprint,
      actorId: lease.actorId,
      key: lease.key,
      conversationId: lease.conversationId,
      serviceUrl,
      rootMessageId,
      updatedAt: new Date().toISOString(),
    };
    this.rows = [row, ...this.rows.filter((old) => old.key !== row.key)].slice(0, 128);
    const temporary = this.path + ".tmp";
    NodeFS.writeFileSync(temporary, JSON.stringify(this.rows), { mode: 0o600 });
    NodeFS.renameSync(temporary, this.path);
  }
  restore(config: TeamsGatewayConfig, isActive: (lease: GatewayLease) => boolean) {
    return this.rows.flatMap((row) => {
      const binding = config.bindings.find((binding) => binding.id === row.bindingId);
      if (!binding || !safeTeamsServiceUrl(row.serviceUrl)) return [];
      const lease: GatewayLease = {
        binding,
        fingerprint: row.fingerprint,
        actorId: row.actorId,
        key: row.key,
        conversationId: row.conversationId,
      };
      return isActive(lease)
        ? [{ lease, serviceUrl: row.serviceUrl, rootMessageId: row.rootMessageId }]
        : [];
    });
  }
}

type RestoredActivity = TeamsResponseActivity & {
  readonly from: { readonly id: string; readonly role: "bot" };
  readonly conversation: { readonly id: string };
};

interface RestoredConversationsApi {
  createActivity(conversationId: string, activity: RestoredActivity): Promise<{ id?: string }>;
  updateActivity(
    conversationId: string,
    activityId: string,
    activity: RestoredActivity,
  ): Promise<unknown>;
}

/**
 * Restored bridges have no turn context. Edits after a restart failed while in-turn edits (the
 * SDK's context sender) worked; match its `from` + `conversation` envelope for edits too.
 */
export function restoredTeamsSender(input: {
  readonly conversations: RestoredConversationsApi;
  readonly conversationId: string;
  readonly botId: string;
}) {
  return async (wire: TeamsResponseActivity): Promise<{ id?: string }> => {
    const payload: RestoredActivity = {
      ...wire,
      from: { id: input.botId, role: "bot" },
      conversation: { id: input.conversationId },
    };
    if (wire.id) {
      await input.conversations.updateActivity(input.conversationId, wire.id, payload);
      return { id: wire.id };
    }
    return input.conversations.createActivity(input.conversationId, payload);
  };
}
