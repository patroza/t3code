import { applyServerConfigProjection, type RpcSession } from "@t3tools/client-runtime/rpc";
import type { ServerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

/** Follow the session's replayed snapshot and subsequent catalog/settings updates. */
export function followBotServerConfig(
  session: Pick<RpcSession, "subscribeServerConfig">,
  onConfig: (config: ServerConfig) => void,
) {
  return Effect.suspend(() => {
    let projection: Parameters<typeof applyServerConfigProjection>[0] = Option.none();
    return session.subscribeServerConfig({}).pipe(
      Stream.runForEach((event) =>
        Effect.sync(() => {
          projection = applyServerConfigProjection(projection, event);
          if (Option.isSome(projection)) onConfig(projection.value.config);
        }),
      ),
    );
  });
}
