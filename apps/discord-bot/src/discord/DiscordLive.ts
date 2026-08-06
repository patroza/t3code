import { NodeHttpClient, NodeSocket } from "@effect/platform-node";
import { Discord, DiscordConfig, DiscordREST, Intents } from "dfx";
import * as Redacted from "effect/Redacted";
import { DiscordIxLive } from "dfx/gateway";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { withSuppressEmbeds } from "../presentation/suppressEmbeds.ts";

/** Intents required for channel mentions → agent turns. */
export const BOT_GATEWAY_INTENTS = Intents.fromList([
  "Guilds",
  "GuildMessages",
  "MessageContent",
  "GuildMessageReactions",
]);

/**
 * Wrap DiscordREST so every createMessage / updateMessage sets SuppressEmbeds.
 * Link previews are suppressed; file attachments are unaffected (separate multipart fields).
 *
 * Uses getUnsafe because Layer.build's output type is opaque to Context.get's
 * "service must be in Services" constraint, even though DiscordIxLive always
 * provides DiscordREST.
 */
const wrapDiscordRestSuppressEmbeds = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
  Layer.effectContext(
    Effect.gen(function* () {
      const ctx = yield* Layer.build(layer);
      const rest = Context.getUnsafe(ctx, DiscordREST);
      return Context.add(
        ctx,
        DiscordREST,
        DiscordREST.of({
          ...rest,
          createMessage: (channelId, options) =>
            rest.createMessage(channelId, withSuppressEmbeds(options)),
          updateMessage: (channelId, messageId, options) =>
            rest.updateMessage(channelId, messageId, withSuppressEmbeds(options)),
        }),
      ) as Context.Context<A>;
    }),
  );

export const makeDiscordLayer = (token: string) =>
  wrapDiscordRestSuppressEmbeds(
    DiscordIxLive.pipe(
      // provideMerge keeps DiscordConfig in the runtime (not only as a hidden dep).
      // Bridge multipart uploads yield DiscordConfig for token + REST baseUrl.
      Layer.provideMerge(
        DiscordConfig.layer({
          token: Redacted.make(token),
          gateway: {
            // Explicit bitfield (also loggable at boot).
            intents: BOT_GATEWAY_INTENTS,
          },
        }),
      ),
      Layer.provide([NodeHttpClient.layerUndici, NodeSocket.layerWebSocketConstructor]),
    ),
  );

export function describeIntents(bitfield: number): string {
  const names = Object.entries(Discord.GatewayIntentBits)
    .filter(([, bit]) => typeof bit === "number" && (bitfield & bit) === bit)
    .map(([name]) => name);
  return `${bitfield} [${names.join(", ")}]`;
}

/** Config-based variant when token comes from env via Config. */
export const DiscordLayerFromEnv = wrapDiscordRestSuppressEmbeds(
  DiscordIxLive.pipe(
    Layer.provideMerge(
      DiscordConfig.layerConfig({
        token: Config.redacted("DISCORD_BOT_TOKEN"),
        gateway: {
          intents: Config.succeed(
            Intents.fromList([
              "Guilds",
              "GuildMessages",
              "MessageContent",
              "GuildMessageReactions",
            ]),
          ),
        },
      }),
    ),
    Layer.provide([NodeHttpClient.layerUndici, NodeSocket.layerWebSocketConstructor]),
  ),
);
