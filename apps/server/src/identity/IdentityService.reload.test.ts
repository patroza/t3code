// @effect-diagnostics nodeBuiltinImport:off
// Staging a real file on disk is the point of these tests: they cover the
// fs-backed reload path, so they use node:fs directly like IdentityService does.
import { AuthSessionId, IdentityUsername } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as IdentityService from "./IdentityService.ts";

const TTL = IdentityService.IDENTITY_MAP_RELOAD_TTL_MS;

const mapYaml = (usernames: ReadonlyArray<string>) =>
  ["people:", ...usernames.map((u) => `  "id-${u}":\n    username: ${u}\n    name: ${u}`)].join(
    "\n",
  );

/**
 * The source fingerprints on ino/size/mtime, so a rewrite inside the same clock
 * millisecond could otherwise look unchanged. Stamp a strictly increasing mtime
 * rather than reading wall-clock time (which the Effect lint rules disallow).
 */
let mtimeSeconds = 1_700_000_000;
function touch(file: string): void {
  mtimeSeconds += 10;
  NodeFS.utimesSync(file, mtimeSeconds, mtimeSeconds);
}

/** Writes the map and points T3_IDENTITY_MAP_PATH at it; returns the path. */
function stageMap(usernames: ReadonlyArray<string>): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "identity-map-"));
  const file = NodePath.join(dir, "identity-map.yaml");
  NodeFS.writeFileSync(file, mapYaml(usernames), "utf8");
  touch(file);
  process.env.T3_IDENTITY_MAP_PATH = file;
  return file;
}

function rewrite(file: string, usernames: ReadonlyArray<string>): void {
  NodeFS.writeFileSync(file, mapYaml(usernames), "utf8");
  touch(file);
}

describe("identity map reload", () => {
  it.effect("applies an added person after the TTL, without a restart", () =>
    Effect.gen(function* () {
      const file = stageMap(["patroza"]);
      const source = IdentityService.makeFileSourceForTest();

      const before = yield* source.current;
      expect(before.people.map((p) => p.username)).toEqual(["patroza"]);

      rewrite(file, ["patroza", "micseg"]);

      // Still cached until the TTL elapses.
      yield* TestClock.adjust(Duration.millis(TTL - 1));
      expect((yield* source.current).people).toHaveLength(1);

      yield* TestClock.adjust(Duration.millis(2));
      const after = yield* source.current;
      expect(after.people.map((p) => p.username)).toEqual(["patroza", "micseg"]);
      expect(after.enabled).toBe(true);
      expect(after.healthy).toBe(true);
    }),
  );

  it.effect("keeps the last good map when a re-read yields no people", () =>
    Effect.gen(function* () {
      const file = stageMap(["patroza", "micseg"]);
      const source = IdentityService.makeFileSourceForTest();
      expect((yield* source.current).people).toHaveLength(2);

      // Simulates a truncated or half-staged file.
      NodeFS.writeFileSync(file, "", "utf8");
      touch(file);

      yield* TestClock.adjust(Duration.millis(TTL + 1));
      const degraded = yield* source.current;
      expect(degraded.people).toHaveLength(2);
      // The gate must stay on: enabled === false would turn it off entirely.
      expect(degraded.enabled).toBe(true);
      expect(degraded.healthy).toBe(false);

      // Recovers once the file is readable again.
      rewrite(file, ["patroza", "micseg", "enricopolanski"]);
      yield* TestClock.adjust(Duration.millis(TTL + 1));
      const recovered = yield* source.current;
      expect(recovered.people).toHaveLength(3);
      expect(recovered.healthy).toBe(true);
    }),
  );

  it.effect("refuses operate for a removed person without deleting their claim", () => {
    // Must be staged before the layer is built: the source loads at construction.
    const file = stageMap(["patroza", "micseg"]);
    return Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      const sessionId = AuthSessionId.make("00000000-0000-4000-8000-0000000000cc");

      yield* identity.claim(sessionId, { username: IdentityUsername.make("micseg") });
      expect(yield* identity.requireOperateClaim(sessionId)).not.toBeNull();

      rewrite(file, ["patroza"]);
      yield* TestClock.adjust(Duration.millis(TTL + 1));

      // Operate is refused...
      const refused = yield* identity.requireOperateClaim(sessionId).pipe(Effect.exit);
      expect(Exit.isFailure(refused)).toBe(true);

      // ...but the claim was not destroyed, so re-adding the person restores it.
      const stillThere = yield* identity.getSessionClaim(sessionId);
      expect(stillThere.claim?.username).toBe("micseg");

      rewrite(file, ["patroza", "micseg"]);
      yield* TestClock.adjust(Duration.millis(TTL + 1));
      expect(yield* identity.requireOperateClaim(sessionId)).not.toBeNull();
    }).pipe(Effect.provide(IdentityService.layer));
  });
});
