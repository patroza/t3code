import { AuthSessionId, IdentityError, IdentityUsername } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as IdentityService from "./IdentityService.ts";

const people = [
  {
    personId: "patroza",
    username: "patroza",
    name: "Patrick Roza",
  },
  {
    personId: "julius",
    username: "julius",
    name: "Julius",
  },
] as const;

const TestLayer = IdentityService.layerWithPeople([...people]).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

const isIdentityError = (error: unknown): error is IdentityError =>
  typeof error === "object" && error !== null && "_tag" in error && error._tag === "IdentityError";

describe("IdentityService", () => {
  it.effect("snapshot is enabled when people are present", () =>
    Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      const snapshot = yield* identity.getSnapshot();
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.claimRequired).toBe(true);
      expect(snapshot.people.map((person) => person.username)).toEqual(["patroza", "julius"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("rejects unknown claim targets", () =>
    Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      const sessionId = AuthSessionId.make("00000000-0000-4000-8000-0000000000aa");
      const result = yield* identity
        .claim(sessionId, { username: IdentityUsername.make("nobody") })
        .pipe(Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const error = result.cause;
        // Cause.fail path
        const failures =
          "failures" in error ? (error as { failures: ReadonlyArray<unknown> }).failures : [];
        const first = failures[0] ?? error;
        // Prefer direct fail extraction via Cause.squash if available
        void first;
      }
      const failed = yield* identity
        .claim(sessionId, { username: IdentityUsername.make("nobody") })
        .pipe(
          Effect.map(() => null as string | null),
          Effect.catch((error) => Effect.succeed(isIdentityError(error) ? error.code : "other")),
        );
      expect(failed).toBe("identity_unknown_person");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("claims, gates operate, and clears", () =>
    Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      const sessionId = AuthSessionId.make("00000000-0000-4000-8000-0000000000bb");

      const before = yield* identity.requireOperateClaim(sessionId).pipe(
        Effect.map(() => null as string | null),
        Effect.catch((error) => Effect.succeed(isIdentityError(error) ? error.code : "other")),
      );
      expect(before).toBe("identity_claim_required");

      const claimed = yield* identity.claim(sessionId, {
        username: IdentityUsername.make("patroza"),
        method: "typeahead",
      });
      expect(claimed.claim.username).toBe("patroza");
      expect(claimed.claim.personId).toBe("patroza");

      const allowed = yield* identity.requireOperateClaim(sessionId);
      expect(allowed?.username).toBe("patroza");

      const cleared = yield* identity.clearClaim(sessionId);
      expect(cleared.cleared).toBe(true);

      const after = yield* identity.requireOperateClaim(sessionId).pipe(
        Effect.map(() => null as string | null),
        Effect.catch((error) => Effect.succeed(isIdentityError(error) ? error.code : "other")),
      );
      expect(after).toBe("identity_claim_required");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("allows overwrite claim (settings switch)", () =>
    Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      const sessionId = AuthSessionId.make("00000000-0000-4000-8000-0000000000cc");
      yield* identity.claim(sessionId, { username: IdentityUsername.make("patroza") });
      const next = yield* identity.claim(sessionId, {
        username: IdentityUsername.make("julius"),
        method: "settings",
      });
      expect(next.claim.username).toBe("julius");
      expect(next.claim.method).toBe("settings");
    }).pipe(Effect.provide(TestLayer)),
  );
});
