import * as NodeCrypto from "node:crypto";

/**
 * Verify inbound Jira webhook auth.
 *
 * Jira Cloud classic webhooks do not always sign the body. We accept either:
 * - `Authorization: Bearer <secret>`
 * - `X-T3-Webhook-Secret: <secret>`
 * - Optional `X-Hub-Signature-256: sha256=<hex>` when the proxy signs the raw body
 */
export function verifyJiraWebhookSecret(input: {
  readonly secret: string;
  readonly authorizationHeader: string | undefined;
  readonly t3SecretHeader: string | undefined;
  readonly body: string;
  readonly signatureHeader: string | undefined;
}): boolean {
  const expected = input.secret.trim();
  if (expected.length === 0) return false;

  const bearer = parseBearer(input.authorizationHeader);
  if (bearer !== null && timingSafeEqualString(bearer, expected)) return true;

  const headerSecret = input.t3SecretHeader?.trim();
  if (headerSecret !== undefined && headerSecret.length > 0) {
    if (timingSafeEqualString(headerSecret, expected)) return true;
  }

  if (input.signatureHeader) {
    return verifySha256Signature({
      secret: expected,
      body: input.body,
      signature: input.signatureHeader,
    });
  }

  return false;
}

function parseBearer(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const match = /^Bearer\s+(\S+)\s*$/iu.exec(authorization.trim());
  return match?.[1] ?? null;
}

function verifySha256Signature(input: {
  readonly secret: string;
  readonly body: string;
  readonly signature: string;
}): boolean {
  if (!/^sha256=[0-9a-f]{64}$/iu.test(input.signature)) return false;
  const received = Buffer.from(input.signature.slice("sha256=".length), "hex");
  const expected = NodeCrypto.createHmac("sha256", input.secret).update(input.body).digest();
  return received.length === expected.length && NodeCrypto.timingSafeEqual(received, expected);
}

function timingSafeEqualString(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    // Still perform a compare to reduce trivial timing oracles on length alone for short secrets.
    NodeCrypto.timingSafeEqual(Buffer.alloc(a.length), Buffer.alloc(a.length));
    return false;
  }
  return NodeCrypto.timingSafeEqual(a, b);
}
