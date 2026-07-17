// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  SERVER_RUNTIME_DESCRIPTOR_FILE,
  ServerRuntimeDescriptor,
  type ServerRuntimeDescriptor as ServerRuntimeDescriptorValue,
} from "@t3tools/shared/serverRuntime";
import * as Schema from "effect/Schema";

const decodeDescriptor = Schema.decodeUnknownExit(ServerRuntimeDescriptor);

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function readLiveExistingBackend(
  stateDir: string,
): ServerRuntimeDescriptorValue | undefined {
  try {
    const path = NodePath.join(stateDir, SERVER_RUNTIME_DESCRIPTOR_FILE);
    const decoded = decodeDescriptor(JSON.parse(NodeFS.readFileSync(path, "utf8")));
    if (decoded._tag === "Failure") return undefined;
    if (NodePath.resolve(decoded.value.stateDir) !== NodePath.resolve(stateDir)) return undefined;
    if (!processIsAlive(decoded.value.pid)) return undefined;
    const url = new URL(decoded.value.httpBaseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return decoded.value;
  } catch {
    return undefined;
  }
}
