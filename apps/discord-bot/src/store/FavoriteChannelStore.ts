// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off tryCatchInEffectGen:off missingEffectError:off
/**
 * Per-user rambling-channel overrides for `/favorite`.
 *
 * Identity-map `ramblingChannelId` is the operator default; this file wins when
 * someone runs `/favorite channel:#…` (so they can set it without a secrets edit).
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { expandHomePath } from "../projectAliases.ts";
import { parseDiscordChannelId } from "../presentation/favorite.ts";

export interface FavoriteChannelStoreService {
  readonly get: (discordUserId: string) => Effect.Effect<string | null>;
  readonly set: (discordUserId: string, channelId: string) => Effect.Effect<void>;
}

export class FavoriteChannelStore extends Context.Service<
  FavoriteChannelStore,
  FavoriteChannelStoreService
>()("@t3tools/discord-bot/store/FavoriteChannelStore") {}

const DISCORD_SNOWFLAKE = /^\d{1,32}$/u;

export function parseFavoriteChannelsDocument(raw: unknown): ReadonlyMap<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return new Map();
  }
  const entries: Array<readonly [string, string]> = [];
  for (const [userId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!DISCORD_SNOWFLAKE.test(userId)) continue;
    const channelId = typeof value === "string" ? parseDiscordChannelId(value) : null;
    if (channelId === null) continue;
    entries.push([userId, channelId]);
  }
  return new Map(entries);
}

export const makeFavoriteChannelStore = (dataDirRaw: string) =>
  Effect.gen(function* () {
    const dataDir = expandHomePath(dataDirRaw);
    const filePath = NodePath.join(dataDir, "favorite-channels.json");
    yield* Effect.promise(() => NodeFSP.mkdir(dataDir, { recursive: true, mode: 0o700 }));

    const initial = yield* Effect.tryPromise({
      try: () => NodeFSP.readFile(filePath, "utf8"),
      catch: () => null,
    }).pipe(
      Effect.map((raw) => {
        if (raw === null) return new Map<string, string>();
        try {
          return parseFavoriteChannelsDocument(JSON.parse(raw) as unknown);
        } catch {
          return new Map<string, string>();
        }
      }),
      Effect.orElseSucceed(() => new Map<string, string>()),
    );

    const state = yield* Ref.make(new Map(initial));

    const persist = (value: ReadonlyMap<string, string>) =>
      Effect.promise(() =>
        NodeFSP.writeFile(
          filePath,
          `${JSON.stringify(Object.fromEntries(value.entries()), null, 2)}\n`,
          { mode: 0o600 },
        ),
      );

    return FavoriteChannelStore.of({
      get: (discordUserId) =>
        Ref.get(state).pipe(Effect.map((map) => map.get(discordUserId.trim()) ?? null)),
      set: (discordUserId, channelId) =>
        Effect.gen(function* () {
          const userId = discordUserId.trim();
          const parsed = parseDiscordChannelId(channelId);
          if (userId.length === 0 || parsed === null) return;
          const next = yield* Ref.updateAndGet(state, (current) => {
            const copy = new Map(current);
            copy.set(userId, parsed);
            return copy;
          });
          yield* persist(next);
        }),
    });
  });

export const layer = (dataDir: string) =>
  Layer.effect(FavoriteChannelStore, makeFavoriteChannelStore(dataDir));
