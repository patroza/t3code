import { describe, expect, it } from "vite-plus/test";

import { formatOmegentLinkMarker, parseOmegentLinkMarker } from "./linkMarker.ts";

const marker = {
  t3ThreadId: "thread-1",
  projectShortName: "macs-scanner",
  sourceKind: "teams" as const,
  sourceThreadId: "native/tenant/group/19:chat@thread.v2/2026-W48",
};

describe("omegent link marker", () => {
  it("round-trips as the last line of a link message", () => {
    const line = formatOmegentLinkMarker(marker);
    expect(line).toBe(
      "-# omegent-link t3:thread-1 project:macs-scanner source:teams:native/tenant/group/19:chat@thread.v2/2026-W48",
    );
    expect(
      parseOmegentLinkMarker(["Linked **macs-scanner**", "[Open in Omegent](x)", line].join("\n")),
    ).toEqual(marker);
  });

  it("ignores text that only mentions the marker", () => {
    expect(parseOmegentLinkMarker("see omegent-link t3:thread-1 project:x source:teams:y")).toBe(
      null,
    );
    expect(parseOmegentLinkMarker("-# omegent-link t3:thread-1 project:x source:slack:y")).toBe(
      null,
    );
    expect(parseOmegentLinkMarker("")).toBe(null);
  });
});
