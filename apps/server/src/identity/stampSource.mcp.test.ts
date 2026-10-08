import { AuthSessionId, IdentityUsername, PersonId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as IdentityService from "./IdentityService.ts";
import { sourceRefForMcpCaller } from "./stampSource.ts";

const people = [
  {
    personId: "andreasimonecosta",
    username: "andreasimonecosta",
    name: "Andrea Simone Costa",
  },
] as const;

const TestLayer = IdentityService.layerWithPeople([...people]);

describe("sourceRefForMcpCaller", () => {
  it.effect("stamps the person claimed on the MCP session", () =>
    Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      const sessionId = AuthSessionId.make("mcp-session");
      yield* identity.claim(sessionId, {
        username: IdentityUsername.make("andreasimonecosta"),
        method: "settings",
      });
      const source = yield* sourceRefForMcpCaller({ clientSessionId: sessionId });
      expect(source).toMatchObject({
        channel: "bot",
        personId: "andreasimonecosta",
        username: "andreasimonecosta",
        actor: { platformId: "andreasimonecosta", displayName: "Andrea Simone Costa" },
      });
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("stays anonymous when the session has no claim", () =>
    Effect.gen(function* () {
      const source = yield* sourceRefForMcpCaller({
        clientSessionId: "mcp-session",
      });
      expect(source).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("keeps a parent person ahead of the session claim", () =>
    Effect.gen(function* () {
      const identity = yield* IdentityService.IdentityService;
      const sessionId = AuthSessionId.make("mcp-session");
      yield* identity.claim(sessionId, {
        username: IdentityUsername.make("andreasimonecosta"),
        method: "settings",
      });
      const parentOrigin = {
        channel: "discord" as const,
        personId: PersonId.make("patroza"),
        username: IdentityUsername.make("patroza"),
      };
      const source = yield* sourceRefForMcpCaller({
        clientSessionId: sessionId,
        parentOrigin,
      });
      expect(source).toBe(parentOrigin);
    }).pipe(Effect.provide(TestLayer)),
  );
});
