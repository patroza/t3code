import { describe, expect, it } from "vite-plus/test";

import { appendOmegentT3ProductHandshake } from "./omegentProductHandshake.ts";

describe("appendOmegentT3ProductHandshake", () => {
  it("adds the product params pre-rebuild fork servers require and keeps existing ones", () => {
    const url = new URL(
      appendOmegentT3ProductHandshake(
        "wss://int.example.test/ws?orchestrationProtocol=2&wsToken=t",
      ),
    );
    expect(url.searchParams.get("productFamily")).toBe("omegent-t3");
    expect(url.searchParams.get("productToken")).toBe("omegent-t3-product-v1-9c4e2f71a8b6");
    expect(url.searchParams.get("orchestrationProtocol")).toBe("2");
    expect(url.searchParams.get("wsToken")).toBe("t");
  });
});
