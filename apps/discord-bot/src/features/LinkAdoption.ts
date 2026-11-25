// @effect-diagnostics missingEffectContext:off
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { ThreadLinkStore } from "../store/ThreadLinkStore.ts";
import { T3Session } from "../t3/T3Session.ts";
import { parseOmegentLinkMarker, type OmegentLinkMarker } from "./linkMarker.ts";
import { bridgeThreadToDiscord } from "./ResponseBridge.ts";

/** Newest link marker this bot posted among Discord messages (any order). */
export function findSelfLinkMarker(
  messages: ReadonlyArray<unknown>,
  botUserId: string,
): OmegentLinkMarker | null {
  for (const message of messages) {
    if (typeof message !== "object" || message === null) continue;
    const { author, content } = message as {
      readonly author?: { readonly id?: unknown } | null;
      readonly content?: unknown;
    };
    if (author?.id !== botUserId || typeof content !== "string") continue;
    const marker = parseOmegentLinkMarker(content);
    if (marker !== null) return marker;
  }
  return null;
}

/**
 * Link a Discord thread another process opened (the Teams gateway) to its T3 thread, and
 * bridge T3 output into it from here. An active link already in the store wins.
 */
export const adoptMarkedDiscordThread = Effect.fn("LinkAdoption.adoptMarkedDiscordThread")(
  function* (input: {
    readonly discordThreadId: string;
    readonly parentChannelId: string | null;
    readonly guildId: string;
    readonly marker: OmegentLinkMarker;
  }) {
    const links = yield* ThreadLinkStore;
    const t3 = yield* T3Session;
    const existing = yield* links.getByDiscordThreadId(input.discordThreadId);
    if (existing !== null && existing.status === "active") return existing;
    const shell = yield* t3.getThreadShell(ThreadId.make(input.marker.t3ThreadId));
    if (shell === null) {
      yield* Effect.logWarning("Link marker names a T3 thread that is not available", {
        discordThreadId: input.discordThreadId,
        t3ThreadId: input.marker.t3ThreadId,
      });
      return null;
    }
    yield* links.put({
      sourceKind: input.marker.sourceKind,
      sourceThreadId: input.marker.sourceThreadId,
      discordThreadId: input.discordThreadId,
      t3ThreadId: shell.id,
      projectId: shell.projectId,
      channelId: input.parentChannelId ?? input.discordThreadId,
      guildId: input.guildId,
      createdAt: DateTime.formatIso(yield* DateTime.now),
    });
    // Rehydrate catches up a turn the gateway already started or finished.
    yield* bridgeThreadToDiscord({
      discordChannelId: input.discordThreadId,
      t3ThreadId: shell.id,
      mode: "rehydrate",
      preferred: true,
    });
    yield* Effect.logInfo("Adopted Discord thread from its link marker", {
      discordThreadId: input.discordThreadId,
      t3ThreadId: shell.id,
      sourceKind: input.marker.sourceKind,
    });
    return yield* links.getByDiscordThreadId(input.discordThreadId);
  },
);
