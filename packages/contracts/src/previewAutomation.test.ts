// @effect-diagnostics globalDate:off -- The codec test builds a Date because that is what page.evaluate returns.
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PreviewAutomationResponse, jsonValueFromUnknown } from "./previewAutomation.ts";

const encodeResponse = Schema.encodeUnknownSync(Schema.toCodecJson(PreviewAutomationResponse));

const responseBase = {
  clientId: "discord-browser-operator-default",
  connectionId: "connection-1",
  requestId: "preview-22",
  ok: true,
};

describe("PreviewAutomationResponse JSON codec", () => {
  it("encodes a Date and a non-finite number as JSON", () => {
    const encoded = encodeResponse({
      ...responseBase,
      result: { seen: new Date("2026-09-30T07:40:54.000Z"), width: Number.NaN, keep: "board" },
    });

    expect(encoded.result).toEqual({
      seen: "2026-09-30T07:40:54.000Z",
      width: null,
      keep: "board",
    });
  });

  it("encodes a cycle instead of rejecting the response", () => {
    const cycle: { self?: unknown; board: string } = { board: "flowchart" };
    cycle.self = cycle;

    expect(encodeResponse({ ...responseBase, result: cycle }).result).toEqual({
      board: "flowchart",
      self: "[Circular]",
    });
  });

  it("projects bigint and leaves plain JSON unchanged", () => {
    expect(jsonValueFromUnknown({ count: 1n, keep: "board" })).toEqual({
      count: "1",
      keep: "board",
    });
    expect(jsonValueFromUnknown(undefined)).toBeUndefined();
  });
});
