// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off tryCatchInEffectGen:off missingEffectError:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { expandHomePath } from "../projectAliases.ts";

export interface TeamsSeenStoreService {
  readonly hasSeen: (channelKey: string, messageId: string) => Effect.Effect<boolean>;
  readonly listSeenIds: (channelKey: string) => Effect.Effect<ReadonlyArray<string>>;
  readonly markSeen: (channelKey: string, messageId: string) => Effect.Effect<void>;
}

export class TeamsSeenStore extends Context.Service<TeamsSeenStore, TeamsSeenStoreService>()(
  "@t3tools/discord-bot/store/TeamsSeenStore",
) {}

const MAX_MESSAGE_IDS_PER_CHANNEL = 500;

export const layer = (dataDirRaw: string) =>
  Layer.effect(
    TeamsSeenStore,
    Effect.gen(function* () {
      const dataDir = expandHomePath(dataDirRaw);
      const filePath = NodePath.join(dataDir, "teams-seen.json");
      yield* Effect.promise(() => NodeFSP.mkdir(dataDir, { recursive: true, mode: 0o700 }));

      const initial = yield* Effect.tryPromise({
        try: () => NodeFSP.readFile(filePath, "utf8"),
        catch: () => null,
      }).pipe(
        Effect.map((raw) => {
          if (raw === null) return {} as Record<string, ReadonlyArray<string>>;
          const parsed = JSON.parse(raw) as unknown;
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return {} as Record<string, ReadonlyArray<string>>;
          }
          const entries = Object.entries(parsed as Record<string, unknown>).flatMap(
            ([channelKey, value]) =>
              Array.isArray(value) && value.every((item) => typeof item === "string")
                ? [[channelKey, value] as const]
                : [],
          );
          return Object.fromEntries(entries);
        }),
        Effect.orElseSucceed(() => ({}) as Record<string, ReadonlyArray<string>>),
      );

      const state = yield* Ref.make(
        new Map(
          Object.entries(initial).map(([channelKey, messageIds]) => [channelKey, [...messageIds]]),
        ),
      );

      const persist = (value: Map<string, string[]>) =>
        Effect.promise(() =>
          NodeFSP.writeFile(
            filePath,
            `${JSON.stringify(Object.fromEntries(value.entries()), null, 2)}\n`,
            { mode: 0o600 },
          ),
        );

      return TeamsSeenStore.of({
        hasSeen: (channelKey, messageId) =>
          Ref.get(state).pipe(Effect.map((map) => (map.get(channelKey) ?? []).includes(messageId))),
        listSeenIds: (channelKey) =>
          Ref.get(state).pipe(Effect.map((map) => [...(map.get(channelKey) ?? [])])),
        markSeen: (channelKey, messageId) =>
          Effect.gen(function* () {
            const next = yield* Ref.updateAndGet(state, (current) => {
              const copy = new Map(current);
              const existing = copy.get(channelKey) ?? [];
              if (existing.includes(messageId)) {
                return copy;
              }
              copy.set(channelKey, [...existing, messageId].slice(-MAX_MESSAGE_IDS_PER_CHANNEL));
              return copy;
            });
            yield* persist(next);
          }),
      });
    }),
  );
