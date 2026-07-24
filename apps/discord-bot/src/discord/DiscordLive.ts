import { NodeHttpClient, NodeSocket } from "@effect/platform-node";
import { Discord, DiscordConfig, Intents } from "dfx";
import * as Redacted from "effect/Redacted";
import { DiscordIxLive } from "dfx/gateway";
import * as Config from "effect/Config";
import * as Layer from "effect/Layer";

/** Intents required for channel mentions → agent turns. */
export const BOT_GATEWAY_INTENTS = Intents.fromList([
  "Guilds",
  "GuildMessages",
  "MessageContent",
  "GuildMessageReactions",
]);

export const makeDiscordLayer = (token: string) =>
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
  );

export function describeIntents(bitfield: number): string {
  const names = Object.entries(Discord.GatewayIntentBits)
    .filter(([, bit]) => typeof bit === "number" && (bitfield & bit) === bit)
    .map(([name]) => name);
  return `${bitfield} [${names.join(", ")}]`;
}

/** Config-based variant when token comes from env via Config. */
export const DiscordLayerFromEnv = DiscordIxLive.pipe(
  Layer.provideMerge(
    DiscordConfig.layerConfig({
      token: Config.redacted("DISCORD_BOT_TOKEN"),
      gateway: {
        intents: Config.succeed(
          Intents.fromList(["Guilds", "GuildMessages", "MessageContent", "GuildMessageReactions"]),
        ),
      },
    }),
  ),
  Layer.provide([NodeHttpClient.layerUndici, NodeSocket.layerWebSocketConstructor]),
);
