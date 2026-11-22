import * as Effect from "effect/Effect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

// The Discord bot's token exchange and environment discovery must answer while provider
// recovery still holds the command gate, or every bot reconnect stalls behind it.
const EXEMPT_PATHS: ReadonlySet<string> = new Set(["/oauth/token", "/.well-known/t3/environment"]);

export const isCommandReadinessExemptPath = (url: string): boolean =>
  EXEMPT_PATHS.has(url.split(/[?#]/u, 1)[0] ?? url);

/** Runs `httpEffect` directly for exempt paths and `gated` (the readiness wait) otherwise. */
export const exemptBootstrapPaths =
  <A, E, R>(httpEffect: Effect.Effect<A, E, R>) =>
  <E2, R2>(
    gated: Effect.Effect<A, E2, R2>,
  ): Effect.Effect<A, E | E2, R | R2 | HttpServerRequest.HttpServerRequest> =>
    Effect.flatMap(
      HttpServerRequest.HttpServerRequest,
      (request): Effect.Effect<A, E | E2, R | R2> =>
        isCommandReadinessExemptPath(request.url) ? httpEffect : gated,
    );
