// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import { makeFavoriteChannelStore, parseFavoriteChannelsDocument } from "./FavoriteChannelStore.ts";

describe("parseFavoriteChannelsDocument", () => {
  it("keeps snowflake user → channel pairs", () => {
    const parsed = parseFavoriteChannelsDocument({
      "593167616273809448": "1402982606877757440",
      nope: "1402982606877757440",
      "111": "not-a-channel",
    });
    expect(parsed.get("593167616273809448")).toBe("1402982606877757440");
    expect(parsed.size).toBe(1);
  });

  it("rejects non-objects", () => {
    expect(parseFavoriteChannelsDocument(null).size).toBe(0);
    expect(parseFavoriteChannelsDocument(["1402982606877757440"]).size).toBe(0);
  });
});

describe("makeFavoriteChannelStore", () => {
  effectIt.effect("round-trips get/set to disk", () =>
    Effect.gen(function* () {
      const dir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-bot-favorite-")),
      );
      const store = yield* makeFavoriteChannelStore(dir);
      expect(yield* store.get("593167616273809448")).toBeNull();
      yield* store.set("593167616273809448", "1402982606877757440");
      expect(yield* store.get("593167616273809448")).toBe("1402982606877757440");

      const reloaded = yield* makeFavoriteChannelStore(dir);
      expect(yield* reloaded.get("593167616273809448")).toBe("1402982606877757440");
    }),
  );
});
