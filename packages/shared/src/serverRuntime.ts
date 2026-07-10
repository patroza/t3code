import * as Schema from "effect/Schema";

// Deliberately distinct from ServerConfig.serverRuntimeStatePath
// (`server-runtime.json`), which is the replaceable health heartbeat.
export const SERVER_RUNTIME_DESCRIPTOR_FILE = "server-owner.json";
export const LOCAL_BOOTSTRAP_CREDENTIAL_FILE = "local-bootstrap-credential";

export const ServerRuntimeDescriptor = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  stateDir: Schema.String,
  httpBaseUrl: Schema.String,
  startedAt: Schema.String,
});
export type ServerRuntimeDescriptor = typeof ServerRuntimeDescriptor.Type;
