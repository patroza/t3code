// Environments still on the pre-rebuild fork (IHD) reject WebSocket clients without these
// params; current servers ignore them. The static token blocks accidental upstream clients, not DRM.
const PRODUCT_FAMILY = "omegent-t3";
const PRODUCT_TOKEN = "omegent-t3-product-v1-9c4e2f71a8b6";

export function appendOmegentT3ProductHandshake(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("productFamily", PRODUCT_FAMILY);
  parsed.searchParams.set("productToken", PRODUCT_TOKEN);
  return parsed.toString();
}
