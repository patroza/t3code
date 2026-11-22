import { describe, expect, it } from "vite-plus/test";

import { extractT3ThreadId, parseLinkThreadCommand } from "./t3ThreadRef.ts";

describe("extractT3ThreadId", () => {
  it("returns bare ids", () => {
    expect(extractT3ThreadId("  abc-123  ")).toBe("abc-123");
    expect(extractT3ThreadId("550e8400-e29b-41d4-a716-446655440000")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("extracts thread from query strings and full URLs", () => {
    expect(extractT3ThreadId("https://t3.example.com/?thread=tid-1")).toBe("tid-1");
    expect(extractT3ThreadId("http://127.0.0.1:5173/?foo=1&thread=tid-2")).toBe("tid-2");
    expect(extractT3ThreadId("https://host/?thread=tid%2Fwith%2Fslash")).toBe("tid/with/slash");
  });

  it("rejects empty or ambiguous values", () => {
    expect(extractT3ThreadId("")).toBeNull();
    expect(extractT3ThreadId("https://example.com/path")).toBeNull();
    expect(extractT3ThreadId("not a single token")).toBeNull();
  });
});

describe("parseLinkThreadCommand", () => {
  it("parses link / pick-up / pickup with bare id or url", () => {
    expect(parseLinkThreadCommand("link tid-1")).toEqual({
      kind: "link-thread",
      t3ThreadId: "tid-1",
    });
    expect(parseLinkThreadCommand("  Pick-Up   https://x/?thread=tid-2  ")).toEqual({
      kind: "link-thread",
      t3ThreadId: "tid-2",
    });
    expect(parseLinkThreadCommand("pickup tid-3")).toEqual({
      kind: "link-thread",
      t3ThreadId: "tid-3",
    });
  });

  it("requires exact command form", () => {
    expect(parseLinkThreadCommand("link")).toBeNull();
    expect(parseLinkThreadCommand("link tid-1 please")).toBeNull();
    expect(parseLinkThreadCommand("please link tid-1")).toBeNull();
    expect(parseLinkThreadCommand("fix the flaky test")).toBeNull();
  });
});
