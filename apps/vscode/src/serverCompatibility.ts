export interface ServerCapabilities {
  readonly forkExtensions: boolean;
  readonly identity: boolean;
  readonly queuedMessages: boolean;
  readonly aiUsage: boolean;
  readonly hostResources: boolean;
}

export const UPSTREAM_SERVER_CAPABILITIES: ServerCapabilities = {
  forkExtensions: false,
  identity: false,
  queuedMessages: false,
  aiUsage: false,
  hostResources: false,
};

export const FORK_SERVER_CAPABILITIES: ServerCapabilities = {
  forkExtensions: true,
  identity: true,
  queuedMessages: true,
  aiUsage: true,
  hostResources: true,
};

/**
 * Fork RPC clients contain every locally-known method even when the connected
 * server does not implement it, so property-existence checks cannot distinguish
 * an upstream server. Identity is a harmless fork-only read and doubles as the
 * compatibility probe; a method-not-found response selects the upstream subset.
 */
export async function detectServerCapabilities(
  probeForkRpc: () => Promise<unknown>,
): Promise<ServerCapabilities> {
  try {
    await probeForkRpc();
    return FORK_SERVER_CAPABILITIES;
  } catch {
    return UPSTREAM_SERVER_CAPABILITIES;
  }
}
