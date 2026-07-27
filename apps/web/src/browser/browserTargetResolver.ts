import type {
  BrowserNavigationTarget,
  EnvironmentId,
  PreviewUrlResolution,
} from "@t3tools/contracts";
import { PreviewPortUnreachableError } from "@t3tools/contracts";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { isLoopbackHost, normalizePreviewUrl } from "@t3tools/shared/preview";
import { Schema } from "effect";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { readPreparedConnection } from "~/state/session";

const normalizeHostname = (host: string): string => host.toLowerCase().replace(/^\[|\]$/g, "");

const parseIpv4Address = (host: string): readonly number[] | null => {
  const parts = normalizeHostname(host).split(".").map(Number);
  return parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? parts
    : null;
};

const isLocalLoopbackHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (normalized === "localhost" || normalized === "::1") return true;
  return parseIpv4Address(normalized)?.[0] === 127;
};

const isPrivateNetworkHost = (host: string): boolean => {
  const normalized = normalizeHostname(host);
  if (isLocalLoopbackHost(normalized) || normalized.endsWith(".local")) {
    return true;
  }
  if (normalized.endsWith(".ts.net")) return true;
  const parts = parseIpv4Address(normalized);
  if (parts) {
    return (
      parts[0] === 10 ||
      (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
      (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 169 && parts[1] === 254)
    );
  }
  const firstIpv6Token = normalized.split(":", 1)[0] ?? "";
  if (!normalized.includes(":") || !/^[\da-f]{1,4}$/u.test(firstIpv6Token)) return false;
  const firstIpv6Hextet = Number.parseInt(firstIpv6Token, 16);
  return (
    Number.isInteger(firstIpv6Hextet) &&
    ((firstIpv6Hextet & 0xfe00) === 0xfc00 || (firstIpv6Hextet & 0xffc0) === 0xfe80)
  );
};

const readEnvironmentUrl = (environmentId: EnvironmentId): URL => {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error(`Environment ${environmentId} is not connected.`);
  return new URL(connection.httpBaseUrl);
};

const resolveEnvironmentPortTarget = (
  environmentId: EnvironmentId,
  target: Extract<BrowserNavigationTarget, { readonly kind: "environment-port" }>,
  environmentUrl: URL,
  requestedUrl?: string,
  sourceUrl?: URL,
): PreviewUrlResolution => {
  if (!isPrivateNetworkHost(environmentUrl.hostname)) {
    throw new Error(
      "This environment port needs the planned authenticated preview gateway; its server address is not directly private-network reachable.",
    );
  }
  const protocol = target.protocol ?? "http";
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  const normalizedEnvironmentHost = environmentUrl.hostname.replace(/^\[|\]$/g, "");
  const resolvedHost = normalizedEnvironmentHost.includes(":")
    ? `[${normalizedEnvironmentHost}]`
    : normalizedEnvironmentHost;
  const resolved = sourceUrl
    ? new URL(sourceUrl)
    : new URL(path, `${protocol}://${resolvedHost}:${target.port}`);
  if (sourceUrl) {
    resolved.hostname = resolvedHost;
    resolved.port = String(target.port);
  }
  return {
    requestedUrl: requestedUrl ?? `${protocol}://localhost:${target.port}${path}`,
    resolvedUrl: resolved.toString(),
    resolutionKind: isLocalLoopbackHost(normalizedEnvironmentHost)
      ? "direct"
      : "direct-private-network",
    environmentId,
  };
};

/**
 * Best-effort resolution used for *labels* — the port list, a link rendered in
 * chat. It names the environment host so a remote reader can tell which machine
 * a port lives on, but it cannot know whether that port is published there, so
 * nothing may navigate to its result. Use `resolveNavigableUrl` for that.
 */
export function resolveBrowserNavigationTarget(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): PreviewUrlResolution {
  if (target.kind === "url") {
    let parsed: URL | null = null;
    try {
      parsed = new URL(normalizePreviewUrl(target.url));
    } catch {
      // Preserve the existing direct-navigation behavior so the preview host
      // reports malformed URL errors through its normal navigation path.
    }
    if (parsed && isLoopbackHost(parsed.hostname)) {
      const environmentUrl = readEnvironmentUrl(environmentId);
      if (parsed.hostname === "0.0.0.0" || !isLocalLoopbackHost(environmentUrl.hostname)) {
        return resolveEnvironmentPortTarget(
          environmentId,
          {
            kind: "environment-port",
            port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80)),
            protocol: parsed.protocol === "https:" ? "https" : "http",
            path: `${parsed.pathname}${parsed.search}${parsed.hash}`,
          },
          environmentUrl,
          target.url,
          parsed,
        );
      }
    }
    return {
      requestedUrl: target.url,
      resolvedUrl: target.url,
      resolutionKind: "direct",
      environmentId,
    };
  }
  return resolveEnvironmentPortTarget(environmentId, target, readEnvironmentUrl(environmentId));
}

export function resolveDiscoveredServerUrl(environmentId: EnvironmentId, rawUrl: string): string {
  try {
    const normalizedUrl = normalizePreviewUrl(rawUrl);
    return resolveBrowserNavigationTarget(environmentId, {
      kind: "url",
      url: normalizedUrl,
    }).resolvedUrl;
  } catch {
    return rawUrl;
  }
}

/**
 * Resolution for anything that is about to be *opened*.
 *
 * A port on the environment host is reachable from this client only if
 * something publishes it there, and only the environment knows what that is —
 * whether a tailnet route already exists, on which port, over which scheme. So
 * this asks, rather than rewriting the hostname and hoping the port answers on
 * the other side. When the environment cannot make it reachable it says why,
 * and that surfaces as a real error instead of a browser error page that reads
 * like the app is broken.
 */
export async function resolveNavigableUrl(
  environmentId: EnvironmentId,
  target: BrowserNavigationTarget,
): Promise<string> {
  const label = resolveBrowserNavigationTarget(environmentId, target);
  const requested = new URL(label.requestedUrl);
  const environmentUrl = readEnvironmentUrl(environmentId);
  // Already reachable as written: an external URL, or a local client whose
  // loopback is the same loopback the port is on. A URL the label pass already
  // pointed at the environment host is not — it names the right machine on a
  // port nothing promised to publish there, so it still needs resolving.
  if (label.resolutionKind === "direct" && !namesAnEnvironmentPort(requested, environmentUrl)) {
    return label.resolvedUrl;
  }

  const port = Number(requested.port || (requested.protocol === "https:" ? 443 : 80));
  const result = await runAtomCommand(
    appAtomRegistry,
    previewEnvironment.resolvePort,
    { environmentId, input: { port, clientBaseUrl: environmentUrl.toString() } },
    { label: "resolve preview port", reportFailure: false, reportDefect: false },
  );
  if (result._tag === "Failure") {
    throw new Error(previewPortFailureMessage(squashAtomCommandFailure(result), port));
  }

  return new URL(
    requested.pathname + requested.search + requested.hash,
    result.value.origin,
  ).toString();
}

/**
 * True when a URL points at the environment's own host but a different port —
 * a dev server beside the T3 server, not the T3 server itself. Chat links reach
 * here already rewritten this way by the label pass, so recognizing the shape
 * keeps one resolution path for both spellings of the same port.
 */
const namesAnEnvironmentPort = (candidate: URL, environmentUrl: URL): boolean =>
  normalizeHostname(candidate.hostname) === normalizeHostname(environmentUrl.hostname) &&
  !isLocalLoopbackHost(candidate.hostname) &&
  effectivePort(candidate) !== effectivePort(environmentUrl);

const effectivePort = (url: URL): number =>
  Number(url.port || (url.protocol === "https:" ? 443 : 80));

const isPortUnreachable = Schema.is(PreviewPortUnreachableError);

/**
 * Keeps the environment's own explanation — it names the reason and the next
 * action, which a browser error page cannot.
 */
const previewPortFailureMessage = (error: unknown, port: number): string =>
  isPortUnreachable(error)
    ? error.message
    : `Port ${port} could not be resolved to an address this client can reach: ${String(error)}`;
