// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Schema from "effect/Schema";
import type { TeamsGatewayConfig } from "./gatewayConfig.ts";
import { safeTeamsServiceUrl, type GatewayLease } from "./gatewayPolicy.ts";

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
