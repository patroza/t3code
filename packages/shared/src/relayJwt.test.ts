import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  RelayJwtSignError,
  RelayJwtVerifyError,
  signRelayJwt,
  verifyRelayJwt,
} from "./relayJwt.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const isRelayJwtSignError = Schema.is(RelayJwtSignError);
const isRelayJwtVerifyError = Schema.is(RelayJwtVerifyError);

describe("relayJwt", () => {
  it.effect("signs and verifies relay JWTs", () =>
    Effect.gen(function* () {
      const token = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "test+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          jti: "nonce-1",
          iat: 100,
          exp: 200,
        },
      });

      const payload = yield* verifyRelayJwt({
        publicKey: keyPair.publicKey,
        token,
        typ: "test+jwt",
        issuer: "https://relay.example.test",
        audience: "https://relay.example.test",
        nowEpochSeconds: 150,
      });

      assert.equal(payload.sub, "user_123");
      assert.equal(payload.jti, "nonce-1");
    }),
  );

  it.effect("returns a structured sign error for invalid private key material", () =>
    Effect.gen(function* () {
      const error = yield* signRelayJwt({
        privateKey: "not a pem",
        typ: "test+jwt",
        payload: {},
      }).pipe(Effect.flip);

      assert.equal(error._tag, "RelayJwtSignError");
      assert.equal(error.typ, "test+jwt");
      assert.equal(error.message, "Failed to sign relay JWT (test+jwt).");
      assert.equal(isRelayJwtSignError(error), true);
    }),
  );

  it.effect("returns a structured verify error with expected claim context", () =>
    Effect.gen(function* () {
      const token = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "test+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          iat: 100,
          exp: 200,
        },
      });

      const error = yield* verifyRelayJwt({
        publicKey: keyPair.publicKey,
        token,
        typ: "other+jwt",
        issuer: "https://relay.example.test",
        audience: "https://relay.example.test",
        nowEpochSeconds: 150,
      }).pipe(Effect.flip);

      assert.equal(error._tag, "RelayJwtVerifyError");
      assert.equal(error.typ, "other+jwt");
      assert.equal(error.issuer, "https://relay.example.test");
      assert.equal(error.audience, "https://relay.example.test");
      assert.equal(error.message, "Failed to verify relay JWT (other+jwt).");
      assert.equal(isRelayJwtVerifyError(error), true);
    }),
  );
});
