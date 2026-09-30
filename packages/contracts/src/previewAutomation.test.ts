// @effect-diagnostics globalDate:off -- The codec test builds a Date because that is what page.evaluate returns.
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { PreviewAutomationResponse, jsonValueFromUnknown } from "./previewAutomation.ts";

const responseCodec = Schema.toCodecJson(PreviewAutomationResponse);
const encodeResponse = Schema.encodeUnknownSync(responseCodec);
const decodeResponse = Schema.decodeUnknownSync(responseCodec);

function encodedResult(input: unknown): unknown {
  return decodeResponse(encodeResponse(input)).result;
}

const responseBase = {
  clientId: "discord-browser-operator-default",
  connectionId: "connection-1",
  requestId: "preview-22",
  ok: true,
};

describe("PreviewAutomationResponse JSON codec", () => {
  it("encodes a Date and a non-finite number as JSON", () => {
    expect(
      encodedResult({
        ...responseBase,
        result: { seen: new Date("2026-09-30T07:40:54.000Z"), width: Number.NaN, keep: "board" },
      }),
    ).toEqual({
      seen: "2026-09-30T07:40:54.000Z",
      width: null,
      keep: "board",
    });
  });

  it("encodes a cycle instead of rejecting the response", () => {
    const cycle: { self?: unknown; board: string } = { board: "flowchart" };
    cycle.self = cycle;

    expect(encodedResult({ ...responseBase, result: cycle })).toEqual({
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
