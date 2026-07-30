/**
 * Deterministic micro-avatars from identity usernames (initials + color).
 *
 * Pure presentation helpers for web/mobile — no network, no assets.
 * Real photo URLs can replace these later; seed stays `personId` / `username`.
 *
 * See docs/architecture/source-and-identity.md
 */

export type IdentityAvatarColors = {
  readonly backgroundColor: string;
  readonly color: string;
};

export type IdentityAvatarModel = IdentityAvatarColors & {
  /** 1–2 uppercase letters for the chip. */
  readonly initials: string;
  /** Accessible label, usually the username or display name. */
  readonly label: string;
};

/**
 * Fixed palette (background + readable foreground). Indexed by a stable hash of
 * the person key so the same user always gets the same chip across clients.
 * Colors are slightly muted so dense lists stay calm on dark/light UIs.
 */
export const IDENTITY_AVATAR_PALETTE: ReadonlyArray<IdentityAvatarColors> = [
  { backgroundColor: "#3B5BDB", color: "#FFFFFF" },
  { backgroundColor: "#0CA678", color: "#FFFFFF" },
  { backgroundColor: "#E67700", color: "#FFFFFF" },
  { backgroundColor: "#9C36B5", color: "#FFFFFF" },
  { backgroundColor: "#0B7285", color: "#FFFFFF" },
  { backgroundColor: "#C2255C", color: "#FFFFFF" },
  { backgroundColor: "#2F9E44", color: "#FFFFFF" },
  { backgroundColor: "#364FC7", color: "#FFFFFF" },
  { backgroundColor: "#D9480F", color: "#FFFFFF" },
  { backgroundColor: "#5F3DC4", color: "#FFFFFF" },
  { backgroundColor: "#087F5B", color: "#FFFFFF" },
  { backgroundColor: "#A61E4D", color: "#FFFFFF" },
] as const;

/** FNV-1a 32-bit — fast, stable, no deps. */
export function hashIdentitySeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function identityAvatarColors(seed: string): IdentityAvatarColors {
  const index = hashIdentitySeed(seed) % IDENTITY_AVATAR_PALETTE.length;
  return IDENTITY_AVATAR_PALETTE[index]!;
}

/**
 * Initials from display name when present, otherwise username.
 * - "Patrick Roza" → "PR"
 * - "patroza" → "PA"
 * - "a" → "A"
 * - empty → "?"
 */
export function identityInitials(input: {
  readonly username?: string | null | undefined;
  readonly name?: string | null | undefined;
}): string {
  const name = input.name?.trim() ?? "";
  if (name.length > 0) {
    const words = name.replace(/[_-]+/gu, " ").split(/\s+/u).filter(Boolean);
    if (words.length >= 2) {
      const a = words[0]![0] ?? "";
      const b = words[1]![0] ?? "";
      const pair = `${a}${b}`.toUpperCase();
      if (pair.length > 0) return pair;
    }
    if (words.length === 1) {
      return words[0]!.slice(0, 2).toUpperCase();
    }
  }

  const username = input.username?.trim() ?? "";
  if (username.length === 0) return "?";
  const cleaned = username.replace(/[^a-zA-Z0-9]+/gu, "");
  if (cleaned.length === 0) return username.slice(0, 2).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}

/**
 * Build a micro-avatar model. Prefer `personId` as color seed when available so
 * renames keep the same chip; fall back to username.
 */
export function identityAvatar(input: {
  readonly personId?: string | null | undefined;
  readonly username?: string | null | undefined;
  readonly name?: string | null | undefined;
}): IdentityAvatarModel {
  const username = input.username?.trim() ?? "";
  const name = input.name?.trim() ?? "";
  const seed = (input.personId?.trim() || username || name || "?").toLowerCase();
  const colors = identityAvatarColors(seed);
  return {
    initials: identityInitials({ username, name }),
    label: name.length > 0 ? name : username.length > 0 ? username : "Unknown",
    ...colors,
  };
}
