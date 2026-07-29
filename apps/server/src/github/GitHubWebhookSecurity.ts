import * as NodeBuffer from "node:buffer";
import * as NodeCrypto from "node:crypto";

function signatureBytes(value: string): NodeBuffer.Buffer | null {
  if (!/^sha256=[0-9a-f]{64}$/iu.test(value)) return null;
  return NodeBuffer.Buffer.from(value.slice("sha256=".length), "hex");
}

export function verifyGitHubWebhookSignature(input: {
  readonly secret: string;
  readonly body: string;
  readonly signature: string | undefined;
}): boolean {
  if (!input.signature) return false;
  const received = signatureBytes(input.signature);
  if (!received) return false;
  const expected = NodeCrypto.createHmac("sha256", input.secret).update(input.body).digest();
  return received.length === expected.length && NodeCrypto.timingSafeEqual(received, expected);
}

export function createGitHubAppJwt(input: {
  readonly appId: string;
  readonly privateKey: string;
  readonly nowSeconds: number;
}): string {
  const encode = (value: unknown) =>
    NodeBuffer.Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "RS256", typ: "JWT" });
  const payload = encode({
    iat: input.nowSeconds - 60,
    exp: input.nowSeconds + 9 * 60,
    iss: input.appId,
  });
  const unsigned = `${header}.${payload}`;
  const signature = NodeCrypto.sign(
    "RSA-SHA256",
    NodeBuffer.Buffer.from(unsigned),
    input.privateKey,
  ).toString("base64url");
  return `${unsigned}.${signature}`;
}
