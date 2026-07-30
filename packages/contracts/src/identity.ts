/**
 * Session identity + message/thread source attribution.
 *
 * Closed-set people come from a server identity map file. Interactive clients
 * claim a map person on their auth session; free-form usernames are rejected.
 *
 * Trust note (v1): interactive claim is **map membership only** — any paired
 * session can claim any listed person. That is intentional for trusted-team
 * shared environments, not anti-impersonation. “Mine” is claim-based and
 * spoofable by peers with a session. Discord/Jira auto-claim binds via platform id.
 *
 * See docs/architecture/source-and-identity.md
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { AuthSessionId, TrimmedNonEmptyString, IsoDateTime } from "./baseSchemas.ts";

// ── Username / person ──────────────────────────────────────────

/**
 * Soft max for wire abuse only — not a product length rule.
 * Charset keeps handles safe for `user@channel` display and logs.
 */
export const IDENTITY_HANDLE_SOFT_MAX_LENGTH = 128;

/** Minimum typed characters before the claim UI shows map suggestions. */
export const IDENTITY_CLAIM_TYPEAHEAD_MIN_CHARS = 3;

/**
 * Handle charset: leading alnum, then alnum / `.` / `_` / `-`.
 * No spaces or control chars. No minimum length product rule (single char OK).
 */
export const IDENTITY_HANDLE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

const normalizeHandle = (value: string) => value.trim().toLowerCase();

const IdentityHandleString = TrimmedNonEmptyString.pipe(
  Schema.decodeTo(
    Schema.String,
    SchemaTransformation.transformOrFail({
      decode: (value) => Effect.succeed(normalizeHandle(value)),
      encode: (value) => Effect.succeed(value),
    }),
  ),
).check(
  Schema.isMaxLength(IDENTITY_HANDLE_SOFT_MAX_LENGTH),
  Schema.isPattern(IDENTITY_HANDLE_PATTERN),
);

export const IdentityUsername = IdentityHandleString.pipe(Schema.brand("IdentityUsername"));
export type IdentityUsername = typeof IdentityUsername.Type;

/** Same normalization as username so mine/theirs compares stay case-stable. */
export const PersonId = IdentityHandleString.pipe(Schema.brand("PersonId"));
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
 * Client may only hint non-person fields. Server stamps person from the
 * session claim (or platform map for bots). Never trust client personId/username.
 */
export const ClientSourceHint = Schema.Struct({
  channel: Schema.optionalKey(SourceChannel),
  location: Schema.optionalKey(SourceLocation),
  actor: Schema.optionalKey(SourceActor),
});
export type ClientSourceHint = typeof ClientSourceHint.Type;

/**
 * Server-authored provenance for a user-originated message / thread origin.
 * personId/username absent only when an external actor is unmapped.
 */
export const SourceRef = Schema.Struct({
  channel: SourceChannel,
  personId: Schema.optionalKey(PersonId),
  username: Schema.optionalKey(IdentityUsername),
  location: Schema.optionalKey(SourceLocation),
  actor: Schema.optionalKey(SourceActor),
});
export type SourceRef = typeof SourceRef.Type;

/** Ordered participant on a thread shell (origin first when known). */
export const ThreadParticipantSummary = Schema.Struct({
  personId: PersonId,
  username: IdentityUsername,
  name: Schema.optionalKey(TrimmedNonEmptyString),
  firstChannel: Schema.optionalKey(SourceChannel),
  channels: Schema.optionalKey(Schema.Array(SourceChannel)),
  firstParticipatedAt: IsoDateTime,
});
export type ThreadParticipantSummary = typeof ThreadParticipantSummary.Type;

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

/**
 * Snapshot of the closed identity set.
 * v1: `claimRequired === enabled` (both true when map has people).
 * Full people[] is intentional roster share for typeahead (not privacy isolation).
 */
export const IdentitySnapshot = Schema.Struct({
  /** False when map file missing/empty — no claim gate. */
  enabled: Schema.Boolean,
  people: Schema.Array(IdentityPersonPublic),
  /** v1 always equals `enabled`. */
  claimRequired: Schema.Boolean,
});
export type IdentitySnapshot = typeof IdentitySnapshot.Type;

export const SessionIdentityClaimMethod = Schema.Literals([
  "typeahead",
  "settings",
  "auto-discord",
  "auto-jira",
  "bootstrap",
]);
export type SessionIdentityClaimMethod = typeof SessionIdentityClaimMethod.Type;

export const SessionIdentityClaim = Schema.Struct({
  sessionId: AuthSessionId,
  personId: PersonId,
  username: IdentityUsername,
  claimedAt: IsoDateTime,
  method: SessionIdentityClaimMethod,
});
export type SessionIdentityClaim = typeof SessionIdentityClaim.Type;

export const IdentityClaimInput = Schema.Union([
  Schema.Struct({
    personId: PersonId,
    method: Schema.optionalKey(Schema.Literals(["typeahead", "settings", "bootstrap"])),
  }),
  Schema.Struct({
    username: IdentityUsername,
    method: Schema.optionalKey(Schema.Literals(["typeahead", "settings", "bootstrap"])),
  }),
]);
export type IdentityClaimInput = typeof IdentityClaimInput.Type;

export const IdentityClaimResult = Schema.Struct({
  claim: SessionIdentityClaim,
});
export type IdentityClaimResult = typeof IdentityClaimResult.Type;

export const IdentitySessionClaimResult = Schema.Struct({
  claim: Schema.NullOr(SessionIdentityClaim),
});
export type IdentitySessionClaimResult = typeof IdentitySessionClaimResult.Type;

export class IdentityError extends Schema.TaggedErrorClass<IdentityError>()("IdentityError", {
  code: Schema.Literals([
    "identity_map_disabled",
    "identity_unknown_person",
    "identity_claim_required",
    "identity_claim_missing",
    "identity_map_invalid",
  ]),
  message: Schema.String,
}) {}
