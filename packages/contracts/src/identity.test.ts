import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import {
  IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS,
  IDENTITY_USERNAME_SOFT_MAX_LENGTH,
  IdentityClaimInput,
  IdentityPersonPublic,
  IdentitySnapshot,
  IdentityUsername,
  PersonId,
  SessionIdentityClaim,
  SourceRef,
} from "./identity.ts";
import { AuthSessionId } from "./baseSchemas.ts";

const decodeUsername = Schema.decodeUnknownSync(IdentityUsername);
const decodeSourceRef = Schema.decodeUnknownSync(SourceRef);
const decodeSnapshot = Schema.decodeUnknownSync(IdentitySnapshot);
const decodeClaimInput = Schema.decodeUnknownSync(IdentityClaimInput);
const decodeClaim = Schema.decodeUnknownSync(SessionIdentityClaim);
const decodePerson = Schema.decodeUnknownSync(IdentityPersonPublic);

describe("IdentityUsername", () => {
  it.each(["ab", "pat", "patroza", "a_b-c", "julius", "abcdefghijklmnopq", "1pat", "x"])(
    "accepts wire shape %s (map membership is server-side)",
    (value) => {
      expect(decodeUsername(value)).toBe(value.toLowerCase());
    },
  );

  it("normalizes case to lowercase", () => {
    expect(decodeUsername("PatRoza")).toBe("patroza");
  });

  it("accepts usernames longer than the old 16-char product cap", () => {
    const long = "a".repeat(40);
    expect(decodeUsername(long)).toBe(long);
  });

  it("rejects empty", () => {
    expect(() => decodeUsername("")).toThrow();
    expect(() => decodeUsername("   ")).toThrow();
  });

  it("rejects past soft max", () => {
    expect(() => decodeUsername("a".repeat(IDENTITY_USERNAME_SOFT_MAX_LENGTH + 1))).toThrow();
  });

  it("exports typeahead threshold of 3 characters", () => {
    expect(IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS).toBe(3);
  });
});

describe("SourceRef", () => {
  it("decodes a desktop claim stamp", () => {
    const parsed = decodeSourceRef({
      channel: "desktop",
      personId: "patroza",
      username: "patroza",
    });
    expect(parsed.channel).toBe("desktop");
    expect(parsed.personId).toBe("patroza");
    expect(parsed.username).toBe("patroza");
  });

  it("decodes discord location without resolved person", () => {
    const parsed = decodeSourceRef({
      channel: "discord",
      location: {
        guildId: "1083767712431480922",
        channelId: "1532311945326235829",
        threadId: "1532311945326235829",
      },
      actor: {
        platformId: "95218063095377920",
        displayName: "Patrick Roza",
      },
    });
    expect(parsed.personId).toBeUndefined();
    expect(parsed.location?.guildId).toBe("1083767712431480922");
    expect(parsed.actor?.platformId).toBe("95218063095377920");
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
    expect(parsed.people[0]?.links.githubLogin).toBe("patroza");
  });

  it("defaults empty links on person", () => {
    const person = decodePerson({
      personId: PersonId.make("julius"),
      username: "julius",
    });
    expect(person.links).toEqual({});
  });

  it("accepts claim by username or personId", () => {
    expect(decodeClaimInput({ username: "patroza" })).toEqual({ username: "patroza" });
    expect(decodeClaimInput({ personId: "patroza" })).toEqual({ personId: "patroza" });
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
    expect(claim.username).toBe("patroza");
  });
});
