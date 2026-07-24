/**
 * Omegent T3 product handshake.
 *
 * Our fork servers require connecting clients to present this product family +
 * token on the WebSocket upgrade URL. Official / upstream T3 clients do not
 * send it, so the first RPC fails with a readable authorization error.
 *
 * This is intentionally a shared static token baked into fork builds — enough
 * to block accidental upstream clients, not a DRM scheme.
 */

export const OMEGENT_T3_PRODUCT_FAMILY = "omegent-t3" as const;

/** Static product proof shared by omegent-t3 server + clients. */
export const OMEGENT_T3_PRODUCT_TOKEN = "omegent-t3-product-v1-9c4e2f71a8b6" as const;

export const PRODUCT_FAMILY_QUERY_PARAM = "productFamily" as const;
export const PRODUCT_TOKEN_QUERY_PARAM = "productToken" as const;

export const OMEGENT_T3_CLIENT_REQUIRED_MESSAGE =
  "This environment only accepts omegent-t3 clients (web, desktop, mobile, vscode, discord-bot). Official / upstream T3 clients are not supported.";

export interface ProductHandshake {
  readonly productFamily: string;
  readonly productToken: string;
}

export function isValidOmegentT3ProductHandshake(
  handshake: ProductHandshake | null | undefined,
): boolean {
  if (handshake == null) {
    return false;
  }
  return (
    handshake.productFamily === OMEGENT_T3_PRODUCT_FAMILY &&
    handshake.productToken === OMEGENT_T3_PRODUCT_TOKEN
  );
}

export function parseProductHandshakeFromSearchParams(
  searchParams: URLSearchParams,
): ProductHandshake | null {
  const productFamily = searchParams.get(PRODUCT_FAMILY_QUERY_PARAM)?.trim() ?? "";
  const productToken = searchParams.get(PRODUCT_TOKEN_QUERY_PARAM)?.trim() ?? "";
  if (productFamily.length === 0 || productToken.length === 0) {
    return null;
  }
  return { productFamily, productToken };
}

export function parseProductHandshakeFromUrl(url: string | URL): ProductHandshake | null {
  try {
    const parsed = typeof url === "string" ? new URL(url, "http://localhost") : url;
    return parseProductHandshakeFromSearchParams(parsed.searchParams);
  } catch {
    return null;
  }
}

/** Appends omegent-t3 product handshake query params to a WebSocket/HTTP URL. */
export function appendOmegentT3ProductHandshake(url: string): string {
  const isAbsoluteUrl = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(url);
  const parsed = new URL(url, "http://localhost");
  parsed.searchParams.set(PRODUCT_FAMILY_QUERY_PARAM, OMEGENT_T3_PRODUCT_FAMILY);
  parsed.searchParams.set(PRODUCT_TOKEN_QUERY_PARAM, OMEGENT_T3_PRODUCT_TOKEN);
  if (isAbsoluteUrl) {
    return parsed.toString();
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}
