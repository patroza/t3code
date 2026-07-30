import { describe, expect, it } from "vite-plus/test";

import {
  buildSourceRefFromClaim,
  mergeParticipantSummaries,
  nextOriginSource,
  resolveSourceChannel,
  sourceChannelFromDeviceType,
} from "./sourceAttribution.ts";

describe("sourceChannelFromDeviceType", () => {
  it("maps known device types", () => {
    expect(sourceChannelFromDeviceType("desktop")).toBe("desktop");
    expect(sourceChannelFromDeviceType("mobile")).toBe("mobile");
    expect(sourceChannelFromDeviceType("tablet")).toBe("mobile");
    expect(sourceChannelFromDeviceType("bot")).toBe("bot");
    expect(sourceChannelFromDeviceType("unknown")).toBe("unknown");
    expect(sourceChannelFromDeviceType(undefined)).toBe("unknown");
  });
});

describe("resolveSourceChannel", () => {
  it("prefers explicit channel hints", () => {
    expect(resolveSourceChannel({ deviceType: "desktop", channelHint: "discord" })).toBe("discord");
  });

  it("falls back to device type", () => {
    expect(resolveSourceChannel({ deviceType: "mobile" })).toBe("mobile");
  });
});

describe("buildSourceRefFromClaim", () => {
  it("stamps person fields from claim", () => {
    expect(
      buildSourceRefFromClaim({
        personId: "patroza",
        username: "patroza",
        channel: "desktop",
      }),
    ).toEqual({
      channel: "desktop",
      personId: "patroza",
      username: "patroza",
    });
  });
});

describe("nextOriginSource", () => {
  it("sets origin from first user source only", () => {
    const first = buildSourceRefFromClaim({
      personId: "patroza",
      username: "patroza",
      channel: "web",
    });
    const second = buildSourceRefFromClaim({
      personId: "julius",
      username: "julius",
      channel: "desktop",
    });
    expect(nextOriginSource({ current: null, messageSource: first, role: "user" })).toEqual(first);
    expect(nextOriginSource({ current: first, messageSource: second, role: "user" })).toEqual(
      first,
    );
    expect(nextOriginSource({ current: null, messageSource: first, role: "assistant" })).toBeNull();
  });
});

describe("mergeParticipantSummaries", () => {
  it("appends distinct people and keeps origin first", () => {
    const origin = {
      personId: "patroza",
      username: "patroza",
      firstChannel: "discord" as const,
      firstParticipatedAt: "2026-01-01T00:00:00.000Z",
    };
    const merged = mergeParticipantSummaries({
      existing: [origin],
      source: { personId: "julius", username: "julius", channel: "desktop" },
      participatedAt: "2026-01-01T00:01:00.000Z",
      originPersonId: "patroza",
    });
    expect(merged.map((entry) => entry.personId)).toEqual(["patroza", "julius"]);
  });

  it("ignores unmapped sources and folds a person's channels into one summary", () => {
    const existing = [
      {
        personId: "patroza",
        username: "patroza",
        firstChannel: "discord" as const,
        firstParticipatedAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    expect(
      mergeParticipantSummaries({
        existing,
        source: { channel: "discord" },
        participatedAt: "2026-01-01T00:01:00.000Z",
      }),
    ).toEqual(existing);
    const folded = mergeParticipantSummaries({
      existing,
      source: { personId: "patroza", username: "patroza", channel: "desktop" },
      participatedAt: "2026-01-01T00:02:00.000Z",
    });
    expect(folded).toHaveLength(1);
    expect(folded[0]?.channels).toEqual(["discord", "desktop"]);
    expect(
      mergeParticipantSummaries({
        existing: folded,
        source: { personId: "patroza", username: "patroza", channel: "desktop" },
        participatedAt: "2026-01-01T00:03:00.000Z",
      }),
    ).toBe(folded);
  });
});
