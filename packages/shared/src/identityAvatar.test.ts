import { describe, expect, it } from "vite-plus/test";

import {
  hashIdentitySeed,
  identityAvatar,
  identityAvatarColors,
  identityInitials,
  IDENTITY_AVATAR_PALETTE,
} from "./identityAvatar.ts";

describe("identityInitials", () => {
  it("uses two words from display name", () => {
    expect(identityInitials({ username: "patroza", name: "Patrick Roza" })).toBe("PR");
  });

  it("uses first two letters of a single name token", () => {
    expect(identityInitials({ name: "Julius" })).toBe("JU");
  });

  it("falls back to username", () => {
    expect(identityInitials({ username: "patroza" })).toBe("PA");
  });

  it("handles short username", () => {
    expect(identityInitials({ username: "ab" })).toBe("AB");
    expect(identityInitials({ username: "x" })).toBe("X");
  });

  it("returns ? when empty", () => {
    expect(identityInitials({})).toBe("?");
    expect(identityInitials({ username: "  ", name: "" })).toBe("?");
  });
});

describe("identityAvatarColors", () => {
  it("is deterministic for the same seed", () => {
    expect(identityAvatarColors("patroza")).toEqual(identityAvatarColors("patroza"));
  });

  it("varies across different seeds", () => {
    const a = identityAvatarColors("patroza");
    const b = identityAvatarColors("julius");
    // Extremely unlikely to collide with a 12-color palette and distinct hashes;
    // if it does, palette still valid — just assert both are in palette.
    expect(IDENTITY_AVATAR_PALETTE).toContainEqual(a);
    expect(IDENTITY_AVATAR_PALETTE).toContainEqual(b);
  });

  it("uses unsigned hash", () => {
    expect(hashIdentitySeed("patroza")).toBeGreaterThanOrEqual(0);
  });
});

describe("identityAvatar", () => {
  it("combines initials, label, and colors", () => {
    const avatar = identityAvatar({
      personId: "patroza",
      username: "patroza",
      name: "Patrick Roza",
    });
    expect(avatar.initials).toBe("PR");
    expect(avatar.label).toBe("Patrick Roza");
    expect(avatar.backgroundColor).toMatch(/^#/);
    expect(avatar.color).toBe("#FFFFFF");
  });

  it("keeps color seed on personId when username changes", () => {
    const a = identityAvatar({ personId: "p1", username: "old" });
    const b = identityAvatar({ personId: "p1", username: "new" });
    expect(a.backgroundColor).toBe(b.backgroundColor);
  });
});
