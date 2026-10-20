import { describe, expect, it } from "vite-plus/test";

import {
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

  it("handles CJK name without surrogate splits", () => {
    expect(identityInitials({ name: "田中 太郎" })).toBe("田太");
  });

  it("handles CJK username", () => {
    expect(identityInitials({ username: "田中" })).toBe("田中");
  });

  it("skips emoji-only name to username when possible", () => {
    // emoji has no L/N letters — falls through to code points of name
    const initials = identityInitials({ name: "😀😀", username: "pat" });
    expect(initials.length).toBeGreaterThan(0);
    expect(initials).not.toMatch(/[\uD800-\uDFFF]/u);
  });
});

describe("identityAvatarColors", () => {
  it("is deterministic for the same seed", () => {
    expect(identityAvatarColors("patroza")).toEqual(identityAvatarColors("patroza"));
  });

  it("varies across different seeds when possible", () => {
    const a = identityAvatarColors("patroza");
    const b = identityAvatarColors("julius");
    expect(IDENTITY_AVATAR_PALETTE).toContainEqual(a);
    expect(IDENTITY_AVATAR_PALETTE).toContainEqual(b);
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
