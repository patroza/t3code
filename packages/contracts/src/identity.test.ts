import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS,
  IDENTITY_HANDLE_SOFT_MAX_LENGTH,
  ClientSourceHint,
  IdentityClaimInput,
  IdentityError,
  IdentityPersonPublic,
  IdentitySnapshot,
  IdentityUsername,
  PersonId,
  SessionIdentityClaim,
  SourceRef,
  ThreadParticipantSummary,
} from "./identity.ts";
import { AuthSessionId } from "./baseSchemas.ts";

const decodeUsername = Schema.decodeUnknownSync(IdentityUsername);
const decodePersonId = Schema.decodeUnknownSync(PersonId);
const decodeSourceRef = Schema.decodeUnknownSync(SourceRef);
const decodeClientHint = Schema.decodeUnknownSync(ClientSourceHint);
const decodeSnapshot = Schema.decodeUnknownSync(IdentitySnapshot);
const decodeClaimInput = Schema.decodeUnknownSync(IdentityClaimInput);
const decodeClaim = Schema.decodeUnknownSync(SessionIdentityClaim);
const decodePerson = Schema.decodeUnknownSync(IdentityPersonPublic);
const decodeParticipant = Schema.decodeUnknownSync(ThreadParticipantSummary);

describe("IdentityUsername / PersonId handles", () => {
  it.each(["a", "pat", "patroza", "a_b-c", "julius", "user.name", "x1"])("accepts %s", (value) => {
    expect(decodeUsername(value)).toBe(value.toLowerCase());
    expect(decodePersonId(value)).toBe(value.toLowerCase());
  });

  it("normalizes case to lowercase", () => {
    expect(decodeUsername("PatRoza")).toBe("patroza");
    expect(decodePersonId("PatRoza")).toBe("patroza");
  });

  it("accepts usernames longer than 16 chars within soft max", () => {
    const long = `a${"b".repeat(40)}`;
    expect(decodeUsername(long)).toBe(long);
  });

  it.each([
    ["empty", ""],
    ["spaces", "pat roza"],
    ["control char", "foo\nbar"],
    ["leading dash", "-pat"],
    ["leading underscore", "_pat"],
    ["at-sign", "pat@roza"],
    ["leading dot", ".pat"],
  ])("rejects %s", (_label, value) => {
    expect(() => decodeUsername(value)).toThrow();
    expect(() => decodePersonId(value)).toThrow();
  });

  it("rejects past soft max", () => {
    expect(() => decodeUsername("a".repeat(IDENTITY_HANDLE_SOFT_MAX_LENGTH + 1))).toThrow();
  });

  it("exports typeahead threshold of 3 characters", () => {
    expect(IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS).toBe(3);
  });
});

describe("SourceRef vs ClientSourceHint", () => {
  it("decodes a server stamp with person", () => {
    const parsed = decodeSourceRef({
      channel: "desktop",
      personId: "patroza",
      username: "patroza",
    });
    expect(parsed.channel).toBe("desktop");
    expect(parsed.personId).toBe("patroza");
  });

  it("client hint has no person fields", () => {
    const hint = decodeClientHint({
      channel: "discord",
      location: { guildId: "1", channelId: "2" },
      actor: { platformId: "9", displayName: "Patrick" },
    });
    expect(hint.channel).toBe("discord");
    expect("personId" in hint).toBe(false);
  });

  it("rejects unknown channel", () => {
    expect(() => decodeSourceRef({ channel: "irc" })).toThrow();
  });
});

describe("IdentitySnapshot + claim", () => {
  it("decodes an enabled map snapshot", () => {
    const parsed = decodeSnapshot({
      enabled: true,
      claimRequired: true,
      people: [
        {
          personId: "patroza",
          username: "patroza",
          name: "Patrick Roza",
          links: {
            discordId: "95218063095377920",
            githubLogin: "patroza",
          },
        },
      ],
    });
    expect(parsed.enabled).toBe(true);
    expect(parsed.people[0]?.username).toBe("patroza");
  });

  it("defaults empty links on person", () => {
    const person = decodePerson({
      personId: PersonId.make("julius"),
      username: "julius",
    });
    expect(person.links).toEqual({});
  });

  it("accepts claim by username or personId with optional method", () => {
    expect(decodeClaimInput({ username: "patroza" })).toEqual({ username: "patroza" });
    expect(decodeClaimInput({ personId: "patroza", method: "settings" })).toEqual({
      personId: "patroza",
      method: "settings",
    });
  });

  it("decodes a session claim", () => {
    const claim = decodeClaim({
      sessionId: AuthSessionId.make("00000000-0000-4000-8000-000000000001"),
      personId: "patroza",
      username: "patroza",
      claimedAt: "2026-07-30T12:00:00.000Z",
      method: "typeahead",
    });
    expect(claim.method).toBe("typeahead");
  });

  it("decodes participant summary", () => {
    const row = decodeParticipant({
      personId: "patroza",
      username: "patroza",
      firstChannel: "discord",
      channels: ["discord", "desktop"],
      firstParticipatedAt: "2026-07-30T12:00:00.000Z",
    });
    expect(row.firstChannel).toBe("discord");
    expect(row.channels).toEqual(["discord", "desktop"]);
  });

  it("constructs IdentityError codes", () => {
    const err = new IdentityError({
      code: "identity_unknown_person",
      message: "not in map",
    });
    expect(err.code).toBe("identity_unknown_person");
  });
});
