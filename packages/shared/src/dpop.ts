import { p256 } from "@noble/curves/nist";
import { sha256 } from "@noble/hashes/sha2";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { DpopPublicJwk, normalizeDpopHtuOption } from "./dpopCommon.ts";
import { stableStringify } from "./relaySigning.ts";

export { DpopPublicJwk, normalizeDpopHtu, normalizeDpopHtuOption } from "./dpopCommon.ts";
export type { DpopPublicJwk } from "./dpopCommon.ts";

const DPOP_TYP = "dpop+jwt";
const DPOP_ALG = "ES256";
const DEFAULT_MAX_AGE_SECONDS = 300;

const DpopJwtHeader = Schema.Struct({
  typ: Schema.Literal(DPOP_TYP),
  alg: Schema.Literal(DPOP_ALG),
  jwk: DpopPublicJwk,
});
type DpopJwtHeader = typeof DpopJwtHeader.Type;

const DpopJwtPayload = Schema.Struct({
  htm: Schema.String.check(Schema.isNonEmpty()),
  htu: Schema.String.check(Schema.isNonEmpty()),
  jti: Schema.String.check(Schema.isNonEmpty()),
  iat: Schema.Int,
  ath: Schema.optionalKey(Schema.String),
});
type DpopJwtPayload = typeof DpopJwtPayload.Type;

const decodeDpopJwtHeaderJson = Schema.decodeUnknownOption(Schema.fromJsonString(DpopJwtHeader), {
  onExcessProperty: "preserve",
});
const decodeDpopJwtPayloadJson = Schema.decodeUnknownOption(Schema.fromJsonString(DpopJwtPayload));

export class MissingDpopProofError extends Schema.TaggedErrorClass<MissingDpopProofError>()(
  "MissingDpopProofError",
  {},
) {
  override get message(): string {
    return "Missing DPoP proof.";
  }
}

export class MalformedDpopCompactJwtError extends Schema.TaggedErrorClass<MalformedDpopCompactJwtError>()(
  "MalformedDpopCompactJwtError",
  {},
) {
  override get message(): string {
    return "Invalid DPoP compact JWT.";
  }
}

export class InvalidDpopJwtHeaderError extends Schema.TaggedErrorClass<InvalidDpopJwtHeaderError>()(
  "InvalidDpopJwtHeaderError",
  {},
) {
  override get message(): string {
    return "Invalid DPoP JWT header.";
  }
}

export class InvalidDpopJwtPayloadError extends Schema.TaggedErrorClass<InvalidDpopJwtPayloadError>()(
  "InvalidDpopJwtPayloadError",
  {},
) {
  override get message(): string {
    return "Invalid DPoP JWT payload.";
  }
}

export class DpopThumbprintMismatchError extends Schema.TaggedErrorClass<DpopThumbprintMismatchError>()(
  "DpopThumbprintMismatchError",
  {
    expectedThumbprint: Schema.String,
    actualThumbprint: Schema.String,
  },
) {
  override get message(): string {
    return "DPoP key thumbprint mismatch.";
  }
}

export class DpopMethodMismatchError extends Schema.TaggedErrorClass<DpopMethodMismatchError>()(
  "DpopMethodMismatchError",
  {
    expectedMethod: Schema.String,
    actualMethod: Schema.String,
  },
) {
  override get message(): string {
    return "DPoP method mismatch.";
  }
}

export class DpopUrlMismatchError extends Schema.TaggedErrorClass<DpopUrlMismatchError>()(
  "DpopUrlMismatchError",
  {
    requestUrl: Schema.String,
    proofUrl: Schema.String,
  },
) {
  override get message(): string {
    return "DPoP URL mismatch.";
  }
}

export class DpopAccessTokenHashMismatchError extends Schema.TaggedErrorClass<DpopAccessTokenHashMismatchError>()(
  "DpopAccessTokenHashMismatchError",
  {},
) {
  override get message(): string {
    return "DPoP access token hash mismatch.";
  }
}

export class DpopTimeWindowError extends Schema.TaggedErrorClass<DpopTimeWindowError>()(
  "DpopTimeWindowError",
  {
    iat: Schema.Int,
    nowEpochSeconds: Schema.Int,
    maxAgeSeconds: Schema.Int,
  },
) {
  override get message(): string {
    return "DPoP proof is outside the allowed time window.";
  }
}

export class InvalidDpopSignatureError extends Schema.TaggedErrorClass<InvalidDpopSignatureError>()(
  "InvalidDpopSignatureError",
  {},
) {
  override get message(): string {
    return "Invalid DPoP signature.";
  }
}

export const DpopVerificationError = Schema.Union([
  MissingDpopProofError,
  MalformedDpopCompactJwtError,
  InvalidDpopJwtHeaderError,
  InvalidDpopJwtPayloadError,
  DpopThumbprintMismatchError,
  DpopMethodMismatchError,
  DpopUrlMismatchError,
  DpopAccessTokenHashMismatchError,
  DpopTimeWindowError,
  InvalidDpopSignatureError,
]);
export type DpopVerificationError = typeof DpopVerificationError.Type;

export type DpopVerificationResult =
  | {
      readonly ok: true;
      readonly thumbprint: string;
      readonly jti: string;
      readonly iat: number;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly error: DpopVerificationError;
    };

function rejectDpopProof(error: DpopVerificationError): DpopVerificationResult {
  return { ok: false, reason: error.message, error };
}

function compactJwtParts(proof: string): Option.Option<readonly [string, string, string]> {
  const parts = proof.split(".");
  return parts.length === 3 && parts[0] && parts[1] && parts[2]
    ? Option.some([parts[0], parts[1], parts[2]] as const)
    : Option.none();
}

function base64UrlToBytesOption(value: string): Option.Option<Uint8Array> {
  const result = Encoding.decodeBase64Url(value);
  return Result.isSuccess(result) ? Option.some(result.success) : Option.none();
}

function base64UrlToStringOption(value: string): Option.Option<string> {
  const result = Encoding.decodeBase64UrlString(value);
  return Result.isSuccess(result) ? Option.some(result.success) : Option.none();
}

function decodeBase64UrlJsonOption<A>(
  value: string,
  decodeJson: (input: unknown) => Option.Option<A>,
): Option.Option<A> {
  return Option.flatMap(base64UrlToStringOption(value), decodeJson);
}

function hasPrivateJwkMaterial(header: DpopJwtHeader): boolean {
  return "d" in header.jwk;
}

function proofInput(input: { readonly proof: string | null | undefined }): Option.Option<string> {
  return Option.fromNullishOr(input.proof).pipe(
    Option.map((proof) => proof.trim()),
    Option.filter((proof) => proof.length > 0),
  );
}

function dpopThumbprintInput(jwk: DpopPublicJwk): string {
  return stableStringify({
    crv: jwk.crv,
    kty: jwk.kty,
    x: jwk.x,
    y: jwk.y,
  });
}

export function computeDpopJwkThumbprint(jwk: DpopPublicJwk): string {
  return Encoding.encodeBase64Url(sha256(new TextEncoder().encode(dpopThumbprintInput(jwk))));
}

export function computeDpopAccessTokenHash(accessToken: string): string {
  return Encoding.encodeBase64Url(sha256(new TextEncoder().encode(accessToken)));
}

function publicKeyBytesFromJwkOption(jwk: DpopPublicJwk): Option.Option<Uint8Array> {
  const x = base64UrlToBytesOption(jwk.x);
  const y = base64UrlToBytesOption(jwk.y);
  if (Option.isNone(x) || Option.isNone(y)) {
    return Option.none();
  }
  if (x.value.length !== 32 || y.value.length !== 32) {
    return Option.none();
  }
  const publicKey = new Uint8Array(65);
  publicKey[0] = 0x04;
  publicKey.set(x.value, 1);
  publicKey.set(y.value, 33);
  return Option.some(publicKey);
}

export function verifyDpopProof(input: {
  readonly proof: string | null | undefined;
  readonly method: string;
  readonly url: string;
  readonly nowEpochSeconds: number;
  readonly expectedThumbprint?: string;
  readonly expectedAccessToken?: string;
  readonly maxAgeSeconds?: number;
}): DpopVerificationResult {
  const proof = proofInput(input);
  if (Option.isNone(proof)) {
    return rejectDpopProof(new MissingDpopProofError({}));
  }

  const parts = compactJwtParts(proof.value);
  if (Option.isNone(parts)) {
    return rejectDpopProof(new MalformedDpopCompactJwtError({}));
  }

  const [headerPart, payloadPart, signaturePart] = parts.value;
  const header = decodeBase64UrlJsonOption(headerPart, decodeDpopJwtHeaderJson);
  if (Option.isNone(header)) {
    return rejectDpopProof(new InvalidDpopJwtHeaderError({}));
  }
  if (hasPrivateJwkMaterial(header.value)) {
    return rejectDpopProof(new InvalidDpopJwtHeaderError({}));
  }

  const payload = decodeBase64UrlJsonOption(payloadPart, decodeDpopJwtPayloadJson);
  if (Option.isNone(payload)) {
    return rejectDpopProof(new InvalidDpopJwtPayloadError({}));
  }

  const publicKey = publicKeyBytesFromJwkOption(header.value.jwk);
  if (Option.isNone(publicKey)) {
    return rejectDpopProof(new InvalidDpopJwtHeaderError({}));
  }

  const thumbprint = computeDpopJwkThumbprint(header.value.jwk);
  const expectedThumbprint = Option.fromUndefinedOr(input.expectedThumbprint);
  if (Option.isSome(expectedThumbprint) && thumbprint !== expectedThumbprint.value) {
    return rejectDpopProof(
      new DpopThumbprintMismatchError({
        expectedThumbprint: expectedThumbprint.value,
        actualThumbprint: thumbprint,
      }),
    );
  }

  if (payload.value.htm.toUpperCase() !== input.method.toUpperCase()) {
    return rejectDpopProof(
      new DpopMethodMismatchError({
        expectedMethod: input.method,
        actualMethod: payload.value.htm,
      }),
    );
  }

  const normalizedHtu = normalizeDpopHtuOption(input.url);
  if (Option.isNone(normalizedHtu)) {
    return rejectDpopProof(
      new DpopUrlMismatchError({
        requestUrl: input.url,
        proofUrl: payload.value.htu,
      }),
    );
  }
  if (payload.value.htu !== normalizedHtu.value) {
    return rejectDpopProof(
      new DpopUrlMismatchError({
        requestUrl: input.url,
        proofUrl: payload.value.htu,
      }),
    );
  }

  const expectedAccessToken = Option.fromUndefinedOr(input.expectedAccessToken);
  if (Option.isSome(expectedAccessToken)) {
    const expectedAth = computeDpopAccessTokenHash(expectedAccessToken.value);
    if (payload.value.ath !== expectedAth) {
      return rejectDpopProof(new DpopAccessTokenHashMismatchError({}));
    }
  }

  const maxAgeSeconds = input.maxAgeSeconds ?? DEFAULT_MAX_AGE_SECONDS;
  if (
    payload.value.iat > input.nowEpochSeconds + 5 ||
    input.nowEpochSeconds - payload.value.iat > maxAgeSeconds
  ) {
    return rejectDpopProof(
      new DpopTimeWindowError({
        iat: payload.value.iat,
        nowEpochSeconds: input.nowEpochSeconds,
        maxAgeSeconds,
      }),
    );
  }

  const signature = base64UrlToBytesOption(signaturePart);
  if (Option.isNone(signature)) {
    return rejectDpopProof(new InvalidDpopSignatureError({}));
  }

  try {
    const signatureInputHash = sha256(new TextEncoder().encode(`${headerPart}.${payloadPart}`));
    const verified = p256.verify(signature.value, signatureInputHash, publicKey.value, {
      prehash: false,
      format: "compact",
    });
    return verified
      ? {
          ok: true,
          thumbprint,
          jti: payload.value.jti,
          iat: payload.value.iat,
        }
      : rejectDpopProof(new InvalidDpopSignatureError({}));
  } catch {
    return rejectDpopProof(new InvalidDpopSignatureError({}));
  }
}
