// Grok and Kimi use fixed CLI directories under the OS home; neither exposes a home override.
// Resolve from that home rather than a provider settings homePath.
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";

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
  return path.join(yield* HostProcess.HomeDirectory, ".kimi");
});
