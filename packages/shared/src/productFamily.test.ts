import { describe, expect, it } from "vite-plus/test";

import {
  appendOmegentT3ProductHandshake,
  isValidOmegentT3ProductHandshake,
  OMEGENT_T3_PRODUCT_FAMILY,
  OMEGENT_T3_PRODUCT_TOKEN,
  parseProductHandshakeFromSearchParams,
  parseProductHandshakeFromUrl,
  PRODUCT_FAMILY_QUERY_PARAM,
  PRODUCT_TOKEN_QUERY_PARAM,
} from "./productFamily.ts";

describe("productFamily", () => {
  it("appends product handshake query params to absolute urls", () => {
    const url = appendOmegentT3ProductHandshake("wss://example.test/ws?wsTicket=abc");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("wsTicket")).toBe("abc");
    expect(parsed.searchParams.get(PRODUCT_FAMILY_QUERY_PARAM)).toBe(OMEGENT_T3_PRODUCT_FAMILY);
    expect(parsed.searchParams.get(PRODUCT_TOKEN_QUERY_PARAM)).toBe(OMEGENT_T3_PRODUCT_TOKEN);
  });

  it("appends product handshake query params to relative urls", () => {
    const url = appendOmegentT3ProductHandshake("/ws");
    expect(url).toContain(`${PRODUCT_FAMILY_QUERY_PARAM}=${OMEGENT_T3_PRODUCT_FAMILY}`);
    expect(url).toContain(`${PRODUCT_TOKEN_QUERY_PARAM}=${OMEGENT_T3_PRODUCT_TOKEN}`);
    expect(url.startsWith("/ws?")).toBe(true);
  });

  it("parses and validates the omegent-t3 handshake", () => {
    const url = appendOmegentT3ProductHandshake("ws://127.0.0.1:3777/ws");
    const handshake = parseProductHandshakeFromUrl(url);
    expect(handshake).toEqual({
      productFamily: OMEGENT_T3_PRODUCT_FAMILY,
      productToken: OMEGENT_T3_PRODUCT_TOKEN,
    });
    expect(isValidOmegentT3ProductHandshake(handshake)).toBe(true);
  });

  it("rejects missing or wrong handshakes", () => {
    expect(isValidOmegentT3ProductHandshake(null)).toBe(false);
    expect(
      isValidOmegentT3ProductHandshake({
        productFamily: OMEGENT_T3_PRODUCT_FAMILY,
        productToken: "wrong",
      }),
    ).toBe(false);
    expect(
      parseProductHandshakeFromSearchParams(new URLSearchParams("productFamily=omegent-t3")),
    ).toBeNull();
  });
});
