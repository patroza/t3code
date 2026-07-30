/**
 * Session identity + message/thread source attribution.
 *
 * Closed-set people come from a server identity map file. Interactive clients
 * claim a map person on their auth session; free-form usernames are rejected.
 *
 * See docs/architecture/source-and-identity.md
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { AuthSessionId, TrimmedNonEmptyString, IsoDateTime } from "./baseSchemas.ts";

// ── Username / person ──────────────────────────────────────────

/**
 * Wire form for a map username: trimmed, lowercased, non-empty.
 * Length/charset are not product constraints — membership in the server
 * identity map is the only accept/reject rule. Soft max guards abuse.
 */
export const IDENTITY_USERNAME_SOFT_MAX_LENGTH = 128;

/** Minimum typed characters before the claim UI shows map suggestions. */
export const IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS = 3;

const IdentityUsernameString = TrimmedNonEmptyString.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(value.trim().toLowerCase()),
      encode: (value) => Effect.succeed(value),
    }),
  ),
).check(Schema.isMaxLength(IDENTITY_USERNAME_SOFT_MAX_LENGTH));

export const IdentityUsername = IdentityUsernameString.pipe(Schema.brand("IdentityUsername"));
export type IdentityUsername = typeof IdentityUsername.Type;

export const PersonId = TrimmedNonEmptyString.pipe(Schema.brand("PersonId"));
export type PersonId = typeof PersonId.Type;

// ── Channels / SourceRef ───────────────────────────────────────

export const SourceChannel = Schema.Literals([
  "desktop",
  "web",
  "mobile",
  "discord",
  "github",
  "jira",
  "slack",
  "teams",
  "bot",
  "unknown",
]);
export type SourceChannel = typeof SourceChannel.Type;

export const SourceLocation = Schema.Struct({
  guildId: Schema.optionalKey(TrimmedNonEmptyString),
  channelId: Schema.optionalKey(TrimmedNonEmptyString),
  threadId: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  repo: Schema.optionalKey(TrimmedNonEmptyString),
  number: Schema.optionalKey(Schema.Int),
  kind: Schema.optionalKey(Schema.Literals(["pr", "issue"])),
  projectKey: Schema.optionalKey(TrimmedNonEmptyString),
  issueKey: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SourceLocation = typeof SourceLocation.Type;

export const SourceActor = Schema.Struct({
  platformId: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SourceActor = typeof SourceActor.Type;

/**
 * Provenance for a user-originated message (and thread origin projection).
 * personId/username may be absent when an external actor is unmapped.
 */
export const SourceRef = Schema.Struct({
  channel: SourceChannel,
  personId: Schema.optionalKey(PersonId),
  username: Schema.optionalKey(IdentityUsername),
  location: Schema.optionalKey(SourceLocation),
  actor: Schema.optionalKey(SourceActor),
});
export type SourceRef = typeof SourceRef.Type;

// ── Public identity map (client-safe) ──────────────────────────

export const IdentityPlatformLinkPublic = Schema.Struct({
  discordId: Schema.optionalKey(TrimmedNonEmptyString),
  discordUsername: Schema.optionalKey(TrimmedNonEmptyString),
  githubLogin: Schema.optionalKey(TrimmedNonEmptyString),
  jiraAccountId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type IdentityPlatformLinkPublic = typeof IdentityPlatformLinkPublic.Type;

export const IdentityPersonPublic = Schema.Struct({
  personId: PersonId,
  username: IdentityUsername,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  links: IdentityPlatformLinkPublic.pipe(Schema.withDecodingDefault(Effect.succeed({}))),
});
export type IdentityPersonPublic = typeof IdentityPersonPublic.Type;

/** Snapshot of the closed identity set exposed to clients. */
export const IdentitySnapshot = Schema.Struct({
  /** False when map file missing/empty — no claim gate, no required source stamp. */
  enabled: Schema.Boolean,
  people: Schema.Array(IdentityPersonPublic),
  claimRequired: Schema.Boolean,
});
export type IdentitySnapshot = typeof IdentitySnapshot.Type;

export const SessionIdentityClaim = Schema.Struct({
  sessionId: AuthSessionId,
  personId: PersonId,
  username: IdentityUsername,
  claimedAt: IsoDateTime,
  method: Schema.Literals(["typeahead", "auto-discord", "auto-jira", "bootstrap"]),
});
export type SessionIdentityClaim = typeof SessionIdentityClaim.Type;

export const IdentityClaimInput = Schema.Union([
  Schema.Struct({ personId: PersonId }),
  Schema.Struct({ username: IdentityUsername }),
]);
export type IdentityClaimInput = typeof IdentityClaimInput.Type;

export const IdentityClaimResult = Schema.Struct({
  claim: SessionIdentityClaim,
});
export type IdentityClaimResult = typeof IdentityClaimResult.Type;
