import { AuthSessionId, IdentityError, IdentityUsername } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as IdentityService from "./IdentityService.ts";

const people = [
  {
    personId: "patroza",
    username: "patroza",
    name: "Patrick Roza",
    jira: { accountId: "712020:pat-account" },
  },
  {
    personId: "julius",
    username: "julius",
    name: "Julius",
  },
] as const;

const TestLayer = IdentityService.layerWithPeople([...people]);

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

  it.effect("bot sessions skip the interactive operate claim gate", () =>
    Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      const sessionId = AuthSessionId.make("00000000-0000-4000-8000-0000000000dd");
      const allowed = yield* identity.requireOperateClaim(sessionId, {
        clientDeviceType: "bot",
      });
      expect(allowed).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("resolves mapped Jira account ids and reports map enabled", () =>
    Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      expect(yield* identity.isMapEnabled()).toBe(true);
      const hit = yield* identity.resolveByJiraAccountId("accountid:712020:PAT-ACCOUNT");
      expect(hit?.username).toBe("patroza");
      const miss = yield* identity.resolveByJiraAccountId("712020:stranger");
      expect(miss).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("non-bot sessions still require a claim when map is enabled", () =>
    Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      const sessionId = AuthSessionId.make("00000000-0000-4000-8000-0000000000ee");
      const code = yield* identity
        .requireOperateClaim(sessionId, { clientDeviceType: "desktop" })
        .pipe(
          Effect.map(() => null as string | null),
          Effect.catch((error) => Effect.succeed(isIdentityError(error) ? error.code : "other")),
        );
      expect(code).toBe("identity_claim_required");
    }).pipe(Effect.provide(TestLayer)),
  );
});
