/**
 * Home-directory resolution for the Grok and Kimi CLIs.
 *
 * Neither CLI's T3 settings carry a `homePath` the way Claude's and Codex's
 * do, and neither honours an override env var, so both are read from their
 * fixed default location under the OS home — which is also what Grok records
 * as `grok_home` in its own session summaries.
 *
 * @module GrokKimiHome
 */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/** `~/.grok` — Grok's state directory. */
export const resolveGrokHomePath = Effect.fn("resolveGrokHomePath")(function* (): Effect.fn.Return<
  string,
  never,
  Path.Path
> {
  const path = yield* Path.Path;
  return path.join(NodeOS.homedir(), ".grok");
});

/** `~/.kimi` — Kimi's state directory. */
export const resolveKimiHomePath = Effect.fn("resolveKimiHomePath")(function* (): Effect.fn.Return<
  string,
  never,
  Path.Path
> {
  const path = yield* Path.Path;
  return path.join(NodeOS.homedir(), ".kimi");
});
